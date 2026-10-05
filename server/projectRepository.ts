import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { CellValue, Dataset, DatasetColumn } from '../src/domain/dataset'
import type { VisualizationConfig } from '../src/domain/visualization'
import type { Project } from '../src/infrastructure/projects'
import { PLAN_CATALOG, assertWithinLimit, effectivePlanId } from '../src/domain/saas'
import { query, transaction } from './db'
import type { AuthenticatedOrganization } from './security'
import { recordAudit } from './security'

const scalarSchema = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()])
const datasetSchema = z.object({
  columns: z.array(z.object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(160),
    type: z.enum(['text', 'category', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'unknown']),
  })).max(250),
  rows: z.array(z.record(z.string(), scalarSchema)).max(5_000_000),
})
const filterSchema = z.object({
  id: z.string().min(1).max(100),
  columnId: z.string().min(1).max(100),
  operator: z.enum(['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains', 'between']),
  value: z.string().max(20_000),
  valueTo: z.string().max(20_000).optional(),
})
const visualizationSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['bar', 'bar-horizontal', 'line', 'area', 'pie', 'donut', 'histogram', 'boxplot', 'scatter', 'summary']),
  title: z.string().max(300),
  subtitle: z.string().max(1000),
  dimensionId: z.string().max(100),
  metricId: z.string().max(100),
  aggregation: z.enum(['sum', 'average', 'count', 'min', 'max']),
  sort: z.enum(['none', 'ascending', 'descending']),
  topN: z.number().int().min(0).max(1_000_000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  showLegend: z.boolean(),
  showValues: z.boolean(),
  decimals: z.number().int().min(0).max(8),
  numberFormat: z.enum(['number', 'currency', 'percent']),
  filters: z.array(filterSchema).max(100),
  size: z.enum(['normal', 'wide']).optional(),
  seriesId: z.string().max(100).optional(),
})
const projectSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160),
  dataset: datasetSchema,
  charts: z.array(visualizationSchema).max(100),
})

export type ProjectInput = z.infer<typeof projectSchema>

export function parseProjectInput(value: unknown): ProjectInput {
  return projectSchema.parse(value)
}

function assertDatasetIntegrity(dataset: Dataset): void {
  const ids = new Set(dataset.columns.map((column) => column.id))
  if (ids.size !== dataset.columns.length) throw Object.assign(new Error('Dataset column IDs must be unique.'), { statusCode: 400 })
  for (const row of dataset.rows) {
    for (const key of Object.keys(row)) {
      if (!ids.has(key)) throw Object.assign(new Error('Dataset rows cannot contain values for unknown columns.'), { statusCode: 400 })
    }
  }
}

function assertChartsIntegrity(dataset: Dataset, charts: VisualizationConfig[]): void {
  const columnIds = new Set(dataset.columns.map((column) => column.id))
  for (const chart of charts) {
    if ((chart.dimensionId && !columnIds.has(chart.dimensionId)) ||
      (chart.metricId && !columnIds.has(chart.metricId)) ||
      (chart.seriesId && !columnIds.has(chart.seriesId)) ||
      chart.filters.some((filter) => !columnIds.has(filter.columnId))) {
      throw Object.assign(new Error('Visualizations must reference columns in their own dataset.'), { statusCode: 400 })
    }
  }
}

export async function persistProject(client: PoolClient, organization: AuthenticatedOrganization, userId: string, input: ProjectInput, create: boolean): Promise<Project> {
  const dataset = input.dataset as Dataset
  const columns = dataset.columns as DatasetColumn[]
  const charts = input.charts as VisualizationConfig[]
  assertDatasetIntegrity(dataset)
  assertChartsIntegrity(dataset, charts)
  const limits = PLAN_CATALOG[effectivePlanId(organization)].limits
  let existingRows = 0
  let projectId: string
  if (create) {
    assertWithinLimit(dataset.rows.length, limits.maxRowsPerDataset)
    const id = randomUUID()
    const created = await client.query<{ id: string }>(
      `INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [id, organization.id, input.name],
    )
    projectId = created.rows[0].id
  } else {
    if (!input.id) throw new Error('Project ID is required for updates.')
    const currentRows = await client.query<{ row_count: number }>(
      `SELECT d.row_count FROM datasets d
       JOIN projects p ON p.organization_id = d.organization_id AND p.id = d.project_id
       WHERE p.organization_id = $1 AND p.id = $2 FOR UPDATE`,
      [organization.id, input.id],
    )
    if (!currentRows.rows.length) throw Object.assign(new Error('Project not found in the current organization.'), { statusCode: 404 })
    existingRows = currentRows.rows[0].row_count
    if (dataset.rows.length > existingRows) {
      assertWithinLimit(existingRows, limits.maxRowsPerDataset, dataset.rows.length - existingRows)
    }
    const updated = await client.query<{ id: string }>(
      `UPDATE projects SET name = $1, updated_at = now()
       WHERE organization_id = $2 AND id = $3 RETURNING id`,
      [input.name, organization.id, input.id],
    )
    if (!updated.rows.length) throw Object.assign(new Error('Project not found in the current organization.'), { statusCode: 404 })
    projectId = updated.rows[0].id
  }
  const datasetId = await client.query<{ id: string }>(
    `INSERT INTO datasets (organization_id, project_id, name, row_count, column_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, project_id) DO UPDATE
     SET name = EXCLUDED.name, row_count = EXCLUDED.row_count, column_count = EXCLUDED.column_count, updated_at = now()
     RETURNING id`,
    [organization.id, projectId, input.name, dataset.rows.length, columns.length],
  )
  const persistedDatasetId = datasetId.rows[0].id
  await client.query('DELETE FROM dataset_columns WHERE dataset_id = $1', [persistedDatasetId])
  await client.query('DELETE FROM dataset_rows WHERE dataset_id = $1', [persistedDatasetId])
  if (columns.length) {
    const parameters: unknown[] = []
    const values = columns.map((column, index) => {
      const base = index * 5
      parameters.push(persistedDatasetId, column.id, index, column.name, column.type)
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
    })
    await client.query(
      `INSERT INTO dataset_columns (dataset_id, column_id, position, name, type) VALUES ${values.join(',')}`,
      parameters,
    )
  }
  for (let offset = 0; offset < dataset.rows.length; offset += 500) {
    const batch = dataset.rows.slice(offset, offset + 500)
    const parameters: unknown[] = []
    const values = batch.map((row, index) => {
      const base = index * 3
      parameters.push(persistedDatasetId, offset + index, JSON.stringify(row))
      return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`
    })
    await client.query(
      `INSERT INTO dataset_rows (dataset_id, row_index, "values") VALUES ${values.join(',')}`,
      parameters,
    )
  }
  await client.query('DELETE FROM visualizations WHERE organization_id = $1 AND project_id = $2', [organization.id, projectId])
  for (let offset = 0; offset < charts.length; offset += 1) {
    await client.query(
      `INSERT INTO visualizations (id, organization_id, project_id, position, config)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [randomUUID(), organization.id, projectId, offset, JSON.stringify(charts[offset])],
    )
  }
  await recordAudit(client, organization.id, userId, create ? 'PROJECT_CREATED' : 'PROJECT_UPDATED', 'project', projectId)
  return { id: projectId, name: input.name, dataset, charts, updatedAt: new Date().toISOString() }
}

export async function listOrganizationProjects(organizationId: string): Promise<Project[]> {
  const projects = await query<{ id: string; name: string; updated_at: Date }>(
    'SELECT id, name, updated_at FROM projects WHERE organization_id = $1 ORDER BY updated_at DESC',
    [organizationId],
  )
  return Promise.all(projects.rows.map((project) => readProject(organizationId, project.id, project.name, project.updated_at)))
}

export async function readProject(organizationId: string, projectId: string, knownName?: string, updatedAt?: Date): Promise<Project> {
  const result = await query<{
    project_name: string
    project_updated_at: Date
    dataset_id: string
    columns: DatasetColumn[]
  }>(
    `SELECT p.name AS project_name, p.updated_at AS project_updated_at, d.id AS dataset_id,
       COALESCE(jsonb_agg(jsonb_build_object('id', c.column_id, 'name', c.name, 'type', c.type)
         ORDER BY c.position) FILTER (WHERE c.column_id IS NOT NULL), '[]'::jsonb) AS columns
     FROM projects p
     LEFT JOIN datasets d ON d.organization_id = p.organization_id AND d.project_id = p.id
     LEFT JOIN dataset_columns c ON c.dataset_id = d.id
     WHERE p.organization_id = $1 AND p.id = $2
     GROUP BY p.id, d.id`,
    [organizationId, projectId],
  )
  const metadata = result.rows[0]
  if (!metadata) throw Object.assign(new Error('Project not found in the current organization.'), { statusCode: 404 })
  const rowsResult = metadata.dataset_id
    ? await query<{ values: Record<string, CellValue> }>(
      'SELECT "values" FROM dataset_rows WHERE dataset_id = $1 ORDER BY row_index',
      [metadata.dataset_id],
    )
    : { rows: [] as { values: Record<string, CellValue> }[] }
  const chartResult = await query<{ config: VisualizationConfig }>(
    `SELECT config FROM visualizations WHERE organization_id = $1 AND project_id = $2 ORDER BY position`,
    [organizationId, projectId],
  )
  return {
    id: projectId,
    name: knownName ?? metadata.project_name,
    dataset: { columns: metadata.columns, rows: rowsResult.rows.map((row) => row.values) },
    charts: chartResult.rows.map((row) => row.config),
    updatedAt: (updatedAt ?? metadata.project_updated_at).toISOString(),
  }
}

export async function createOrUpdateProject(input: ProjectInput, organization: AuthenticatedOrganization, userId: string): Promise<Project> {
  return transaction(async (client) => persistProject(client, organization, userId, input, !input.id))
}
