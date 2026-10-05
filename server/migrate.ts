import 'dotenv/config'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL must be configured before running database migrations.')

const pool = new Pool({ connectionString, max: 1 })
try {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const applied = new Set((await pool.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((row) => row.id))
  const directory = join(process.cwd(), 'server', 'migrations')
  const files = (await readdir(directory)).filter((file) => /^\d+_[\w-]+\.sql$/.test(file)).sort()
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(directory, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.info(JSON.stringify({ level: 'info', event: 'migration_applied', migration: file }))
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
} finally {
  await pool.end()
}
