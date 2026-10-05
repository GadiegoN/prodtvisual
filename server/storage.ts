import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { config } from './config'
import { query, transaction } from './db'
import { requireOrganization, requireUser, recordAudit } from './security'
import { assertWithinLimit, effectivePlanId, PLAN_CATALOG } from '../src/domain/saas'

export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}

export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const target = resolve(this.root, key)
    if (!target.startsWith(`${resolve(this.root)}\\`)) throw new Error('Invalid storage key.')
    return target
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.path(key)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, data, { flag: 'wx' })
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key))
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly ready = import('@aws-sdk/client-s3').then(async (sdk) => {
    const client = new sdk.S3Client({
      region: config.OBJECT_STORAGE_REGION,
      endpoint: config.OBJECT_STORAGE_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY!,
        secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY!,
      },
    })
    return { sdk, client }
  })

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const { sdk, client } = await this.ready
    await client.send(new sdk.PutObjectCommand({ Bucket: config.OBJECT_STORAGE_BUCKET, Key: key, Body: data, ContentType: contentType }))
  }

  async get(key: string): Promise<Buffer> {
    const { sdk, client } = await this.ready
    const result = await client.send(new sdk.GetObjectCommand({ Bucket: config.OBJECT_STORAGE_BUCKET, Key: key }))
    if (!result.Body) throw Object.assign(new Error('The requested file was not found.'), { statusCode: 404 })
    return Buffer.from(await result.Body.transformToByteArray())
  }

  async delete(key: string): Promise<void> {
    const { sdk, client } = await this.ready
    await client.send(new sdk.DeleteObjectCommand({ Bucket: config.OBJECT_STORAGE_BUCKET, Key: key }))
  }
}

export function createObjectStorage(): ObjectStorage {
  return config.objectStorageEnabled ? new S3ObjectStorage() : new LocalObjectStorage(resolve(process.cwd(), 'var', 'objects'))
}

const allowedTypes = new Map([
  ['text/csv', '.csv'],
  ['application/json', '.json'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-excel', '.xls'],
])

export async function registerStorageRoutes(app: FastifyInstance, storage: ObjectStorage): Promise<void> {
  app.post('/api/projects/:projectId/files', {
    preHandler: async (request) => {
      await requireUser(request)
      await requireOrganization(request, 'projects.write')
    },
  }, async (request, reply) => {
    const user = request.user!
    const organization = request.organization!
    const projectId = (request.params as { projectId: string }).projectId
    const part = await request.file({ limits: { fileSize: 20 * 1024 * 1024, files: 1 } })
    if (!part) return reply.code(400).send({ error: 'Choose a supported CSV, JSON, XLS, or XLSX file.' })
    const extension = allowedTypes.get(part.mimetype)
    if (!extension || !part.filename.toLowerCase().endsWith(extension)) {
      part.file.resume()
      return reply.code(415).send({ error: 'The file content type and extension must match a supported format.' })
    }
    const data = await part.toBuffer()
    if (!data.length) return reply.code(400).send({ error: 'The uploaded file is empty.' })
    const project = await query<{ id: string }>(
      'SELECT id FROM projects WHERE organization_id = $1 AND id = $2',
      [organization.id, projectId],
    )
    if (!project.rows.length) return reply.code(404).send({ error: 'Project not found in the current organization.' })
    const id = randomUUID()
    const objectKey = `${organization.id}/${projectId}/${id}${extension}`
    await storage.put(objectKey, data, part.mimetype)
    try {
      await transaction(async (client) => {
        await client.query('SELECT id FROM subscriptions WHERE organization_id = $1 FOR UPDATE', [organization.id])
        const total = await client.query<{ bytes: string }>(
          'SELECT COALESCE(sum(size_bytes), 0)::text AS bytes FROM project_files WHERE organization_id = $1',
          [organization.id],
        )
        const plan = PLAN_CATALOG[effectivePlanId(organization)]
        assertWithinLimit(Number(total.rows[0]?.bytes ?? 0), plan.limits.maxStorage, data.byteLength)
        await client.query(
          `INSERT INTO project_files (id, organization_id, project_id, object_key, content_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, organization.id, projectId, objectKey, part.mimetype, data.byteLength],
        )
        await recordAudit(client, organization.id, user.id, 'DATASET_IMPORTED', 'file', id, { sizeBytes: data.byteLength, contentType: part.mimetype })
      })
    } catch (error) {
      await storage.delete(objectKey)
      throw error
    }
    return reply.code(201).send({ id, name: basename(part.filename), size: data.byteLength, contentType: part.mimetype })
  })

  app.get('/api/projects/:projectId/files/:fileId', {
    preHandler: async (request) => {
      await requireUser(request)
      await requireOrganization(request, 'projects.read')
    },
  }, async (request, reply) => {
    const organization = request.organization!
    const { projectId, fileId } = request.params as { projectId: string; fileId: string }
    const result = await query<{ object_key: string; content_type: string }>(
      `SELECT object_key, content_type FROM project_files
       WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
      [organization.id, projectId, fileId],
    )
    const file = result.rows[0]
    if (!file) return reply.code(404).send({ error: 'File not found in the current organization.' })
    const data = await storage.get(file.object_key)
    return reply.type(file.content_type).header('content-disposition', 'attachment').send(data)
  })

  app.delete('/api/projects/:projectId/files/:fileId', {
    preHandler: async (request) => {
      await requireUser(request)
      await requireOrganization(request, 'projects.write')
    },
  }, async (request, reply) => {
    const user = request.user!
    const organization = request.organization!
    const { projectId, fileId } = request.params as { projectId: string; fileId: string }
    const file = await query<{ object_key: string }>(
      `DELETE FROM project_files
       WHERE organization_id = $1 AND project_id = $2 AND id = $3
       RETURNING object_key`,
      [organization.id, projectId, fileId],
    )
    if (!file.rows.length) return reply.code(404).send({ error: 'File not found in the current organization.' })
    await storage.delete(file.rows[0].object_key)
    await query(
      `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'FILE_DELETED', 'file', $3)`,
      [organization.id, user.id, fileId],
    )
    return reply.code(204).send()
  })
}
