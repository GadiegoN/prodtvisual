/// <reference lib="dom" />
import { z } from 'zod'
import type { Dataset } from '../domain/dataset'
import type { VisualizationConfig } from '../domain/visualization'

const STORAGE_KEY = 'vista.projects.v1'
const DATABASE_NAME = 'vista.local-data'
const DATABASE_VERSION = 1
const PROJECT_STORE = 'projects'
const META_STORE = 'metadata'
const LEGACY_MIGRATION_KEY = 'legacyProjectsImported'
export const MAX_LOCAL_PROJECTS = 3

export interface Project {
  id: string
  name: string
  dataset: Dataset
  charts: VisualizationConfig[]
  updatedAt: string
}

const columnSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['text', 'category', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'unknown']),
})
const filterSchema = z.object({
  id: z.string(),
  columnId: z.string(),
  operator: z.enum(['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan', 'between']),
  value: z.string(),
  valueTo: z.string().optional(),
})
const chartSchema = z.object({
  id: z.string(),
  type: z.enum(['bar', 'bar-horizontal', 'line', 'area', 'pie', 'donut', 'histogram', 'boxplot', 'scatter', 'summary']),
  title: z.string(),
  subtitle: z.string(),
  dimensionId: z.string(),
  metricId: z.string(),
  aggregation: z.enum(['sum', 'average', 'count', 'min', 'max']),
  sort: z.enum(['none', 'ascending', 'descending']),
  topN: z.number(),
  color: z.string(),
  showLegend: z.boolean(),
  showValues: z.boolean(),
  decimals: z.number(),
  numberFormat: z.enum(['number', 'currency', 'percent']),
  filters: z.array(filterSchema),
  size: z.enum(['normal', 'wide']).optional(),
  seriesId: z.string().optional(),
})
const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  dataset: z.object({
    columns: z.array(columnSchema),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))),
  }),
  charts: z.array(chartSchema),
  updatedAt: z.string(),
})

export interface ProjectsBackup {
  format: 'vista-projects-backup'
  version: 1
  createdAt: string
  projects: Project[]
}

interface StoredProject {
  id: string
  position: number
  project: Project
}

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(new Error('Este navegador não oferece armazenamento local compatível. Atualize o navegador para continuar.'))
  }
  if (databasePromise) return databasePromise
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PROJECT_STORE)) {
        const projects = database.createObjectStore(PROJECT_STORE, { keyPath: 'id' })
        projects.createIndex('position', 'position', { unique: false })
      }
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE)
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => reject(request.error ?? new Error('Não foi possível abrir o armazenamento local.'))
    request.onblocked = () => reject(new Error('Feche outras abas do Vista para atualizar o armazenamento local.'))
  }).catch((error: unknown) => {
    databasePromise = null
    throw error
  })
  databasePromise = opening
  return opening
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Não foi possível acessar o armazenamento local.'))
  })
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Não foi possível salvar no armazenamento local.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('A gravação local foi cancelada.'))
  })
}

function decodeProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) throw new Error('A lista de projetos salva está inválida.')
  const projects = value.map((item) => {
    const parsed = projectSchema.safeParse(item)
    if (!parsed.success) throw new Error('Um dos projetos salvos tem formato inválido. Exporte uma cópia ou remova o projeto danificado antes de continuar.')
    return parsed.data
  })
  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    throw new Error('A lista de projetos contém identificadores duplicados.')
  }
  return projects
}

async function migrateLegacyProjects(database: IDBDatabase): Promise<void> {
  const readTransaction = database.transaction(META_STORE, 'readonly')
  const alreadyMigrated = await requestResult(readTransaction.objectStore(META_STORE).get(LEGACY_MIGRATION_KEY))
  await transactionResult(readTransaction)
  if (alreadyMigrated === true) return

  const legacy = localStorage.getItem(STORAGE_KEY)
  const legacyProjects = legacy ? decodeProjects(JSON.parse(legacy)) : []
  const transaction = database.transaction([PROJECT_STORE, META_STORE], 'readwrite')
  const store = transaction.objectStore(PROJECT_STORE)
  const existing = store.getAll()
  existing.onsuccess = () => {
    if (existing.result.length === 0) {
      legacyProjects.forEach((project, position) => store.put({ id: project.id, position, project } satisfies StoredProject))
    }
    transaction.objectStore(META_STORE).put(true, LEGACY_MIGRATION_KEY)
  }
  await transactionResult(transaction)
  if (legacy !== null) localStorage.removeItem(STORAGE_KEY)
}

async function readProjects(database?: IDBDatabase): Promise<Project[]> {
  const db = database ?? await openDatabase()
  await migrateLegacyProjects(db)
  const transaction = db.transaction(PROJECT_STORE, 'readonly')
  const records = await requestResult(transaction.objectStore(PROJECT_STORE).getAll()) as StoredProject[]
  await transactionResult(transaction)
  return recordsToProjects(records)
}

function recordsToProjects(records: StoredProject[]): Project[] {
  return records.sort((left, right) => left.position - right.position).map((record) => {
    const parsed = projectSchema.safeParse(record.project)
    if (!parsed.success) throw new Error('Um dos projetos salvos tem formato inválido. Exporte uma cópia ou remova o projeto danificado antes de continuar.')
    return parsed.data
  })
}

async function mutateProjects(transform: (existing: Project[]) => Project[]): Promise<Project[]> {
  const database = await openDatabase()
  await migrateLegacyProjects(database)
  const transaction = database.transaction(PROJECT_STORE, 'readwrite')
  const store = transaction.objectStore(PROJECT_STORE)
  const request = store.getAll()
  let result: Project[] | undefined
  let operationError: unknown
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(result ?? [])
    transaction.onerror = () => {
      const error = operationError ?? transaction.error ?? new Error('Não foi possível salvar no armazenamento local.')
      reject(error instanceof DOMException && error.name === 'QuotaExceededError'
        ? new Error('O espaço disponível no navegador acabou. Exporte um backup, remova projetos ou libere espaço no dispositivo.')
        : error)
    }
    transaction.onabort = () => {
      const error = operationError ?? transaction.error ?? new Error('A gravação local foi cancelada.')
      reject(error instanceof DOMException && error.name === 'QuotaExceededError'
        ? new Error('O espaço disponível no navegador acabou. Exporte um backup, remova projetos ou libere espaço no dispositivo.')
        : error)
    }
    request.onerror = () => {
      operationError = request.error ?? new Error('Não foi possível ler os projetos salvos.')
      transaction.abort()
    }
    request.onsuccess = () => {
      try {
        const existing = recordsToProjects(request.result as StoredProject[])
        result = transform(existing)
        store.clear()
        result.forEach((project, position) => store.put({ id: project.id, position, project } satisfies StoredProject))
      } catch (error) {
        operationError = error
        transaction.abort()
      }
    }
  })
}

export async function listProjects(): Promise<Project[]> {
  try {
    return await readProjects()
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Não foi possível ler os projetos antigos salvos neste navegador.')
    throw error
  }
}

export async function saveProject(project: Project): Promise<Project[]> {
  return mutateProjects((existing) => {
    if (!existing.some((item) => item.id === project.id) && existing.length >= MAX_LOCAL_PROJECTS) {
      throw new Error(`Você pode salvar até ${MAX_LOCAL_PROJECTS} projetos neste navegador. Exclua um projeto existente para salvar outro.`)
    }
    return [project, ...existing.filter((item) => item.id !== project.id)]
  })
}

export async function restoreProjects(projects: Project[], replaceExisting: boolean): Promise<Project[]> {
  const imported = decodeProjects(projects)
  if (!imported.length) throw new Error('O backup não contém projetos para restaurar.')
  return mutateProjects((current) => {
    const existing = replaceExisting ? [] : current
    const next = [...imported, ...existing.filter((project) => !imported.some((item) => item.id === project.id))]
    if (next.length > MAX_LOCAL_PROJECTS) {
      throw new Error(`Este backup e os projetos atuais somam ${next.length} projetos, acima do limite de ${MAX_LOCAL_PROJECTS}. Escolha substituir os projetos atuais ou exclua alguns antes de mesclar.`)
    }
    return next
  })
}

export function createProjectsBackup(projects: Project[]): ProjectsBackup {
  return { format: 'vista-projects-backup', version: 1, createdAt: new Date().toISOString(), projects }
}

export function parseProjectsBackup(value: unknown): ProjectsBackup {
  if (!value || typeof value !== 'object') throw new Error('O arquivo não é um backup válido do Vista.')
  const candidate = value as Record<string, unknown>
  if (candidate.format !== 'vista-projects-backup' || candidate.version !== 1) {
    throw new Error('Este arquivo não é um backup compatível do Vista.')
  }
  const projects = decodeProjects(candidate.projects)
  return {
    format: 'vista-projects-backup',
    version: 1,
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
    projects,
  }
}

export async function deleteProject(id: string): Promise<Project[]> {
  return mutateProjects((existing) => existing.filter((project) => project.id !== id))
}

export async function estimateBrowserStorage(): Promise<{ usage?: number; quota?: number }> {
  if (!navigator.storage?.estimate) return {}
  const { usage, quota } = await navigator.storage.estimate()
  return { usage, quota }
}
