import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { config } from './config'

let pool: Pool | undefined

export function databaseConfigured(): boolean {
  return Boolean(config.DATABASE_URL)
}

export function getPool(): Pool {
  if (!config.DATABASE_URL) throw new ServiceUnavailableError('Configure DATABASE_URL and apply database migrations to enable SaaS accounts.')
  pool ??= new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined,
  })
  return pool
}

export class ServiceUnavailableError extends Error {
  readonly statusCode = 503
  constructor(message: string) { super(message); this.name = 'ServiceUnavailableError' }
}

export async function query<Row extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<Row>> {
  return getPool().query<Row>(text, values)
}

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return
  await pool.end()
  pool = undefined
}

export async function audit(
  organizationId: string | null,
  actorUserId: string | null,
  action: string,
  resourceType?: string,
  resourceId?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await query(
    `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [organizationId, actorUserId, action, resourceType ?? null, resourceId ?? null, JSON.stringify(metadata)],
  )
}
