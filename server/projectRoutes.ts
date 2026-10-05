import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PLAN_CATALOG, SaaSError, assertWithinLimit, effectivePlanId, hasEntitlement } from '../src/domain/saas'
import { query, transaction } from './db'
import { listOrganizationProjects, parseProjectInput, persistProject, readProject } from './projectRepository'
import { requireOrganization, requireUser, recordAudit } from './security'

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'projects.read') },
  }, async (request) => ({ projects: await listOrganizationProjects(request.organization!.id) }))

  app.get('/api/projects/:projectId', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'projects.read') },
  }, async (request) => {
    const projectId = (request.params as { projectId: string }).projectId
    return { project: await readProject(request.organization!.id, projectId) }
  })

  app.post('/api/projects', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'projects.write') },
  }, async (request, reply) => {
    const input = parseProjectInput(request.body)
    const organization = request.organization!
    const project = await transaction(async (client) => {
      await client.query('SELECT id FROM subscriptions WHERE organization_id = $1 FOR UPDATE', [organization.id])
      const plan = PLAN_CATALOG[effectivePlanId(organization)]
      if (!hasEntitlement(organization, 'projects.create')) throw new SaaSError('Project creation is not available on the current plan.', 'PLAN_REQUIRED')
      const projects = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM projects WHERE organization_id = $1', [organization.id])
      assertWithinLimit(Number(projects.rows[0]?.count ?? 0), plan.limits.maxProjects)
      const datasets = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM datasets WHERE organization_id = $1', [organization.id])
      assertWithinLimit(Number(datasets.rows[0]?.count ?? 0), plan.limits.maxDatasets)
      if (input.charts.length) {
        if (!hasEntitlement(organization, 'dashboard.create')) throw new SaaSError('Dashboard creation is not available on the current plan.', 'PLAN_REQUIRED')
        const dashboards = await client.query<{ count: string }>(
          `SELECT count(DISTINCT p.id)::text AS count FROM projects p
           JOIN visualizations v ON v.organization_id = p.organization_id AND v.project_id = p.id
           WHERE p.organization_id = $1`,
          [organization.id],
        )
        assertWithinLimit(Number(dashboards.rows[0]?.count ?? 0), plan.limits.maxDashboards)
      }
      return persistProject(client, organization, request.user!.id, input, true)
    })
    return reply.code(201).send({ project })
  })

  app.put('/api/projects/:projectId', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'projects.write') },
  }, async (request, reply) => {
    const projectId = z.string().uuid().safeParse((request.params as { projectId: string }).projectId)
    if (!projectId.success) return reply.code(400).send({ error: 'Invalid project ID.' })
    const input = parseProjectInput({ ...(request.body as object), id: projectId.data })
    const organization = request.organization!
    const project = await transaction(async (client) => {
      await client.query('SELECT id FROM subscriptions WHERE organization_id = $1 FOR UPDATE', [organization.id])
      const existing = await client.query<{ row_count: number; has_charts: boolean }>(
        `SELECT d.row_count, EXISTS (
           SELECT 1 FROM visualizations v WHERE v.organization_id = p.organization_id AND v.project_id = p.id
         ) AS has_charts
         FROM projects p JOIN datasets d ON d.organization_id = p.organization_id AND d.project_id = p.id
         WHERE p.organization_id = $1 AND p.id = $2`,
        [organization.id, projectId.data],
      )
      if (!existing.rows[0]) throw Object.assign(new Error('Project not found in the current organization.'), { statusCode: 404 })
      if (!existing.rows[0].has_charts && input.charts.length) {
        if (!hasEntitlement(organization, 'dashboard.create')) {
          throw new SaaSError('Dashboard creation is not available on the current plan.', 'PLAN_REQUIRED')
        }
        const dashboards = await client.query<{ count: string }>(
          `SELECT count(DISTINCT p.id)::text AS count FROM projects p
           JOIN visualizations v ON v.organization_id = p.organization_id AND v.project_id = p.id
           WHERE p.organization_id = $1`,
          [organization.id],
        )
        assertWithinLimit(Number(dashboards.rows[0]?.count ?? 0), PLAN_CATALOG[effectivePlanId(organization)].limits.maxDashboards)
      }
      return persistProject(client, organization, request.user!.id, input, false)
    })
    return { project }
  })

  app.delete('/api/projects/:projectId', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'projects.delete') },
  }, async (request, reply) => {
    const parsedId = z.string().uuid().safeParse((request.params as { projectId: string }).projectId)
    if (!parsedId.success) return reply.code(400).send({ error: 'Invalid project ID.' })
    const organization = request.organization!
    const result = await transaction(async (client) => {
      const deleted = await client.query<{ id: string }>(
        'DELETE FROM projects WHERE organization_id = $1 AND id = $2 RETURNING id',
        [organization.id, parsedId.data],
      )
      if (!deleted.rows.length) return false
      await recordAudit(client, organization.id, request.user!.id, 'PROJECT_DELETED', 'project', parsedId.data)
      return true
    })
    if (!result) return reply.code(404).send({ error: 'Project not found in the current organization.' })
    return reply.code(204).send()
  })
}
