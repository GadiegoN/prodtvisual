import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { effectivePlanId, hasEntitlement, PLAN_CATALOG, SaaSError, assertWithinLimit, canManageRole } from '../src/domain/saas'
import type { Entitlement } from '../src/domain/saas'
import { audit, query, transaction } from './db'
import { sendInvitation } from './email'
import { digest, requireOrganization, requireUser, secureToken } from './security'

const organizationNameSchema = z.string().trim().min(1).max(120)
const inviteSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLocaleLowerCase()),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']),
})

export async function registerOrganizationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/organizations', async (request) => {
    const user = await requireUser(request)
    const result = await query(
      `SELECT o.id, o.name, o.slug, m.role, s.plan_id AS "planId", s.status
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
       JOIN subscriptions s ON s.organization_id = o.id
       WHERE m.user_id = $1 ORDER BY o.created_at`,
      [user.id],
    )
    return { organizations: result.rows }
  })

  app.post('/api/organizations', async (request, reply) => {
    const user = await requireUser(request)
    if (!user.emailVerified) return reply.code(403).send({ error: 'Verify your email before creating an organization.' })
    const parsed = z.object({ name: organizationNameSchema }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Enter an organization name between 1 and 120 characters.' })
    const slugBase = parsed.data.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || 'workspace'
    const organization = await transaction(async (client) => {
      const result = await client.query<{ id: string; name: string; slug: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug',
        [parsed.data.name, `${slugBase}-${randomUUID().slice(0, 8)}`],
      )
      const created = result.rows[0]
      await client.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [created.id, user.id, 'OWNER'])
      await client.query(`INSERT INTO subscriptions (organization_id, plan_id, provider, status) VALUES ($1, 'FREE', 'manual', 'free')`, [created.id])
      await client.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'ORGANIZATION_CREATED', 'organization', $3)`,
        [created.id, user.id, created.id],
      )
      return { ...created, role: 'OWNER', planId: 'FREE', status: 'free' }
    })
    return reply.code(201).send({ organization })
  })

  app.patch('/api/organizations/current', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'organization.update') },
  }, async (request, reply) => {
    const parsed = z.object({ name: organizationNameSchema }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Enter an organization name between 1 and 120 characters.' })
    const organization = request.organization!
    await query('UPDATE organizations SET name = $1, updated_at = now() WHERE id = $2', [parsed.data.name, organization.id])
    await audit(organization.id, request.user!.id, 'ORGANIZATION_UPDATED', 'organization', organization.id)
    return { organization: { ...organization, name: parsed.data.name } }
  })

  app.delete('/api/organizations/current', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'organization.delete') },
  }, async (request, reply) => {
    const organization = request.organization!
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'ORGANIZATION_DELETED', 'organization', $3)`,
        [organization.id, request.user!.id, organization.id],
      )
      await client.query('DELETE FROM organizations WHERE id = $1', [organization.id])
    })
    return reply.code(204).send()
  })

  app.get('/api/organizations/current/members', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'organization.read') },
  }, async (request) => {
    const organization = request.organization!
    const result = await query(
      `SELECT u.id, u.email, u.name, m.role, m.created_at AS "joinedAt"
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 ORDER BY m.created_at`,
      [organization.id],
    )
    return { members: result.rows }
  })

  app.post('/api/organizations/current/invitations', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'members.manage') },
  }, async (request, reply) => {
    const organization = request.organization!
    const user = request.user!
    const parsed = inviteSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid email and a supported member role.' })
    if (parsed.data.email === user.email.toLocaleLowerCase()) return reply.code(400).send({ error: 'You already belong to this organization.' })
    if (!hasEntitlement(organization, 'team.members')) {
      return reply.code(402).send({ error: 'Team invitations require the Pro plan or higher.' })
    }
    const existing = await query(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND u.email = $2`,
      [organization.id, parsed.data.email],
    )
    if (existing.rows.length) return reply.code(409).send({ error: 'This account is already a member of the organization.' })
    const usage = await query<{ member_count: string }>('SELECT count(*)::text AS member_count FROM memberships WHERE organization_id = $1', [organization.id])
    assertWithinLimit(Number(usage.rows[0]?.member_count ?? 0), PLAN_CATALOG[effectivePlanId(organization)].limits.maxMembers)
    const token = secureToken()
    const invitationId = randomUUID()
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days')`,
        [invitationId, organization.id, parsed.data.email, parsed.data.role, digest(token), user.id],
      )
      await client.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, 'MEMBER_INVITED', 'invitation', $3, $4::jsonb)`,
        [organization.id, user.id, invitationId, JSON.stringify({ email: parsed.data.email, role: parsed.data.role })],
      )
    })
    try {
      await sendInvitation(parsed.data.email, organization.name, token)
    } catch (error) {
      request.log.error({ err: error, invitationId }, 'Invitation email delivery failed')
      return reply.code(503).send({ error: 'The invitation was saved but could not be emailed. Configure SMTP, revoke this invitation, and create it again.' })
    }
    return reply.code(201).send({ invitation: { id: invitationId, email: parsed.data.email, role: parsed.data.role, status: 'PENDING' } })
  })

  app.get('/api/organizations/current/invitations', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'members.manage') },
  }, async (request) => {
    await query(
      `UPDATE invitations SET status = 'EXPIRED'
       WHERE organization_id = $1 AND status = 'PENDING' AND expires_at <= now()`,
      [request.organization!.id],
    )
    const result = await query(
      `SELECT i.id, i.email, i.role, i.status, i.expires_at AS "expiresAt", i.created_at AS "createdAt",
       u.name AS "invitedBy"
       FROM invitations i JOIN users u ON u.id = i.invited_by
       WHERE i.organization_id = $1 AND i.status = 'PENDING' ORDER BY i.created_at DESC`,
      [request.organization!.id],
    )
    return { invitations: result.rows }
  })

  app.delete('/api/organizations/current/invitations/:invitationId', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'members.manage') },
  }, async (request, reply) => {
    const organization = request.organization!
    const invitationId = (request.params as { invitationId: string }).invitationId
    const result = await query(
      `UPDATE invitations SET status = 'REVOKED'
       WHERE organization_id = $1 AND id = $2 AND status = 'PENDING' RETURNING id`,
      [organization.id, invitationId],
    )
    if (!result.rows.length) return reply.code(404).send({ error: 'Pending invitation not found.' })
    await audit(organization.id, request.user!.id, 'INVITATION_REVOKED', 'invitation', invitationId)
    return reply.code(204).send()
  })

  app.patch('/api/organizations/current/members/:memberId', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'members.manage') },
  }, async (request, reply) => {
    const organization = request.organization!
    const parsed = z.object({ role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Choose OWNER, ADMIN, MEMBER, or VIEWER.' })
    const memberId = (request.params as { memberId: string }).memberId
    const actor = request.organization!.role
    const target = await query<{ role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' }>(
      'SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2',
      [organization.id, memberId],
    )
    if (!target.rows[0]) return reply.code(404).send({ error: 'Organization member not found.' })
    if (!canManageRole(actor, target.rows[0].role, parsed.data.role)) return reply.code(403).send({ error: 'Your role cannot change this member or assign this role.' })
    if (memberId === request.user!.id && parsed.data.role !== 'OWNER') return reply.code(409).send({ error: 'You cannot remove your own owner role.' })
    if (parsed.data.role === 'OWNER' && actor !== 'OWNER') return reply.code(403).send({ error: 'Only an owner can assign the owner role.' })
    await transaction(async (client) => {
      if (parsed.data.role === 'OWNER' && memberId !== request.user!.id) {
        await client.query('UPDATE memberships SET role = $1 WHERE organization_id = $2 AND user_id = $3', ['ADMIN', organization.id, request.user!.id])
      }
      await client.query('UPDATE memberships SET role = $1 WHERE organization_id = $2 AND user_id = $3', [parsed.data.role, organization.id, memberId])
      await client.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, 'ROLE_CHANGED', 'membership', $3, $4::jsonb)`,
        [organization.id, request.user!.id, memberId, JSON.stringify({ oldRole: target.rows[0].role, newRole: parsed.data.role })],
      )
    })
    return { userId: memberId, role: parsed.data.role }
  })

  app.delete('/api/organizations/current/members/:memberId', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'members.manage') },
  }, async (request, reply) => {
    const organization = request.organization!
    const memberId = (request.params as { memberId: string }).memberId
    if (memberId === request.user!.id) return reply.code(409).send({ error: 'Use organization deletion or transfer ownership before leaving as the owner.' })
    const target = await query<{ role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' }>(
      'SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2',
      [organization.id, memberId],
    )
    if (!target.rows[0]) return reply.code(404).send({ error: 'Organization member not found.' })
    if (!canManageRole(organization.role, target.rows[0].role)) return reply.code(403).send({ error: 'Your role cannot remove this member.' })
    await transaction(async (client) => {
      await client.query('DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2', [organization.id, memberId])
      await client.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'MEMBER_REMOVED', 'membership', $3)`,
        [organization.id, request.user!.id, memberId],
      )
    })
    return reply.code(204).send()
  })

  app.get('/api/usage', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'organization.read') },
  }, async (request) => {
    const organization = request.organization!
    const result = await query<{
      projects: string
      datasets: string
      members: string
      rows: string
      storage_bytes: string
      exports: string
    }>(
      `SELECT
       (SELECT count(*) FROM projects WHERE organization_id = $1)::text AS projects,
       (SELECT count(*) FROM datasets WHERE organization_id = $1)::text AS datasets,
       (SELECT count(*) FROM memberships WHERE organization_id = $1)::text AS members,
       (SELECT COALESCE(sum(row_count), 0) FROM datasets WHERE organization_id = $1)::text AS rows,
       (SELECT COALESCE(sum(size_bytes), 0) FROM project_files WHERE organization_id = $1)::text AS storage_bytes,
       (SELECT COALESCE(amount, 0) FROM usage_counters WHERE organization_id = $1 AND usage_key = 'exports' AND period_start = date_trunc('month', current_date)::date)::text AS exports`,
      [organization.id],
    )
    const current = result.rows[0]
    const effectivePlan = effectivePlanId(organization)
    const limits = PLAN_CATALOG[effectivePlan].limits
    return {
      planId: effectivePlan,
      limits,
      usage: {
        projects: { usage: Number(current.projects), limit: limits.maxProjects },
        datasets: { usage: Number(current.datasets), limit: limits.maxDatasets },
        members: { usage: Number(current.members), limit: limits.maxMembers },
        rows: { usage: Number(current.rows), limit: limits.maxRowsPerDataset },
        storage: { usage: Number(current.storage_bytes), limit: limits.maxStorage },
        exportsThisMonth: { usage: Number(current.exports), limit: limits.maxExportsPerMonth },
      },
    }
  })

  app.post('/api/usage/exports', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'organization.read') },
  }, async (request, reply) => {
    const parsed = z.object({ format: z.enum(['csv', 'png', 'svg', 'pdf']) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Choose CSV, PNG, SVG, or PDF export.' })
    const organization = request.organization!
    const entitlements: Record<typeof parsed.data.format, Entitlement> = {
      csv: 'export.csv',
      png: 'export.png',
      svg: 'export.svg',
      pdf: 'export.pdf',
    }
    const entitlement = entitlements[parsed.data.format]
    if (!hasEntitlement(organization, entitlement)) throw new SaaSError('This export format is not available on the current plan.', 'PLAN_REQUIRED')
    await transaction(async (client) => {
      await client.query('SELECT id FROM subscriptions WHERE organization_id = $1 FOR UPDATE', [organization.id])
      const periodStart = await client.query<{ period_start: string }>('SELECT date_trunc(\'month\', current_date)::date::text AS period_start')
      const period = periodStart.rows[0].period_start
      const current = await client.query<{ amount: string }>(
        'SELECT amount::text AS amount FROM usage_counters WHERE organization_id = $1 AND usage_key = $2 AND period_start = $3',
        [organization.id, 'exports', period],
      )
      const limits = PLAN_CATALOG[effectivePlanId(organization)].limits
      assertWithinLimit(Number(current.rows[0]?.amount ?? 0), limits.maxExportsPerMonth)
      await client.query(
        `INSERT INTO usage_counters (organization_id, usage_key, period_start, amount)
         VALUES ($1, 'exports', $2, 1)
         ON CONFLICT (organization_id, usage_key, period_start)
         DO UPDATE SET amount = usage_counters.amount + 1`,
        [organization.id, period],
      )
    })
    return reply.code(204).send()
  })
}
