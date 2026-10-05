import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { hasEntitlement, SaaSError } from '../src/domain/saas'
import { config } from './config'
import { audit, query, transaction } from './db'
import { digest, recordAudit, requireOrganization, requireUser, secureToken } from './security'
import { readProject } from './projectRepository'

export async function registerSharingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/projects/:projectId/shares', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'sharing.manage') },
  }, async (request, reply) => {
    const organization = request.organization!
    const projectId = z.string().uuid().safeParse((request.params as { projectId: string }).projectId)
    const parsed = z.object({
      access: z.enum(['PUBLIC', 'LINK_ONLY']).default('LINK_ONLY'),
      expiresInDays: z.number().int().min(1).max(365).optional(),
    }).safeParse(request.body ?? {})
    if (!projectId.success || !parsed.success) return reply.code(400).send({ error: 'Provide a valid project and sharing configuration.' })
    if (parsed.data.access === 'PUBLIC' && !hasEntitlement(organization, 'share.public')) {
      throw new SaaSError('Public sharing is not available on the current plan.', 'PLAN_REQUIRED')
    }
    const exists = await query('SELECT 1 FROM projects WHERE organization_id = $1 AND id = $2', [organization.id, projectId.data])
    if (!exists.rows.length) return reply.code(404).send({ error: 'Project not found in the current organization.' })
    const token = secureToken()
    const expiresAt = parsed.data.expiresInDays ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000) : null
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO share_links (token_hash, organization_id, project_id, access, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [digest(token), organization.id, projectId.data, parsed.data.access, expiresAt],
      )
      await recordAudit(client, organization.id, request.user!.id, 'SHARE_CREATED', 'project', projectId.data, { access: parsed.data.access })
    })
    return reply.code(201).send({
      share: {
        url: new URL(`/#shared=${token}`, config.APP_ORIGIN).toString(),
        access: parsed.data.access,
        expiresAt,
      },
    })
  })

  app.get('/api/projects/:projectId/shares', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'sharing.manage') },
  }, async (request) => {
    const projectId = (request.params as { projectId: string }).projectId
    const result = await query(
      `SELECT encode(token_hash, 'hex') AS id, access, expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM share_links WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [request.organization!.id, projectId],
    )
    return { shares: result.rows }
  })

  app.delete('/api/projects/:projectId/shares/:shareId', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'sharing.manage') },
  }, async (request, reply) => {
    const organization = request.organization!
    const { projectId, shareId } = request.params as { projectId: string; shareId: string }
    const result = await query(
      `UPDATE share_links SET revoked_at = now()
       WHERE organization_id = $1 AND project_id = $2 AND encode(token_hash, 'hex') = $3 AND revoked_at IS NULL
       RETURNING project_id`,
      [organization.id, projectId, shareId],
    )
    if (!result.rows.length) return reply.code(404).send({ error: 'Active share link not found.' })
    await audit(organization.id, request.user!.id, 'SHARE_REVOKED', 'project', projectId)
    return reply.code(204).send()
  })

  app.get('/api/shares/:token', async (request, reply) => {
    const token = z.string().min(32).max(200).safeParse((request.params as { token: string }).token)
    if (!token.success) return reply.code(404).send({ error: 'This share link is invalid, expired, or revoked.' })
    const result = await query<{ organization_id: string; project_id: string; access: 'PUBLIC' | 'LINK_ONLY' }>(
      `SELECT organization_id, project_id, access FROM share_links
       WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [digest(token.data)],
    )
    const share = result.rows[0]
    if (!share) return reply.code(404).send({ error: 'This share link is invalid, expired, or revoked.' })
    return { project: await readProject(share.organization_id, share.project_id), access: share.access }
  })
}
