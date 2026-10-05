import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import rawBody from 'fastify-raw-body'
import { SaaSError } from '../src/domain/saas'
import { registerAuthRoutes } from './authRoutes'
import { StripeBillingProvider, registerBillingRoutes } from './billing'
import { config } from './config'
import { closeDatabase, databaseConfigured } from './db'
import { registerOrganizationRoutes } from './organizationRoutes'
import { registerProjectRoutes } from './projectRoutes'
import { registerSharingRoutes } from './sharingRoutes'
import { createObjectStorage, registerStorageRoutes } from './storage'

const app = Fastify({
  logger: true,
  bodyLimit: 25 * 1024 * 1024,
  requestTimeout: 30_000,
})

await app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
})
await app.register(cors, {
  origin: config.APP_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['content-type', 'x-organization-id', 'stripe-signature'],
})
await app.register(cookie)
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
await app.register(multipart, {
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 5, parts: 6 },
})
await app.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true })

app.decorateRequest('user', null)
app.decorateRequest('organization', null)

app.get('/api/health', async (_request, reply) => {
  if (!databaseConfigured()) return { status: 'ok', database: 'not-configured', accounts: 'not-configured' }
  try {
    const { getPool } = await import('./db')
    await getPool().query('SELECT 1')
    return { status: 'ok', database: 'available', accounts: config.authEnabled ? 'available' : 'not-configured' }
  } catch (error) {
    app.log.error({ err: error }, 'Database health check failed')
    return reply.code(503).send({ status: 'unavailable', accounts: 'unavailable' })
  }
})

app.setErrorHandler((error, request, reply) => {
  if (error instanceof SaaSError) {
    const status = error.code === 'FORBIDDEN' ? 403
      : error.code === 'NOT_FOUND' ? 404
        : error.code === 'LIMIT_REACHED' ? 409 : 402
    return reply.code(status).send({ error: error.message, code: error.code })
  }
  if (error instanceof Error && error.name === 'ServiceUnavailableError') {
    return reply.code(503).send({ error: error.message })
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return reply.code(400).send({ error: 'The request data is invalid.' })
  }
  if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    return reply.code(error.statusCode).send({ error: error.message })
  }
  request.log.error({ err: error }, 'Request failed')
  return reply.code(500).send({ error: 'An unexpected server error occurred.' })
})

await registerAuthRoutes(app)
await registerOrganizationRoutes(app)
await registerProjectRoutes(app)
await registerSharingRoutes(app)
await registerStorageRoutes(app, createObjectStorage())
await registerBillingRoutes(app, config.stripeEnabled ? new StripeBillingProvider() : null)

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'API route not found.' })
  return reply.code(404).type('text/plain').send('Not Found')
})

app.addHook('onClose', async () => closeDatabase())

try {
  await app.listen({ host: '0.0.0.0', port: config.PORT })
  app.log.info({ port: config.PORT, databaseConfigured: databaseConfigured() }, 'Vista API is listening')
} catch (error) {
  app.log.error({ err: error }, 'Vista API failed to start')
  await app.close()
  process.exitCode = 1
}
