import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inferDataset } from '../domain/dataset'
import {
  createProjectsBackup, deleteProject, listProjects, MAX_LOCAL_PROJECTS, parseProjectsBackup,
  restoreProjects, saveProject,
} from './projects'

const DATABASE_NAME = 'vista.local-data'

function createProject(id: string, rows = [['Grupo', 'Valor'], ['A', '1']]) {
  return {
    id,
    name: id,
    dataset: inferDataset(rows),
    charts: [],
    updatedAt: new Date().toISOString(),
  }
}

async function resetDatabase(): Promise<void> {
  const request = indexedDB.open(DATABASE_NAME, 1)
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' }).createIndex('position', 'position')
      }
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = database.transaction(['projects', 'metadata'], 'readwrite')
  transaction.objectStore('projects').clear()
  transaction.objectStore('metadata').clear()
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

describe('local project storage', () => {
  let values: Map<string, string>

  beforeEach(async () => {
    values = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    await resetDatabase()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('allows three projects and rejects a fourth without changing stored projects', async () => {
    await saveProject(createProject('one'))
    await saveProject(createProject('two'))
    await saveProject(createProject('three'))

    expect(MAX_LOCAL_PROJECTS).toBe(3)
    await expect(saveProject(createProject('four'))).rejects.toThrow(/até 3 projetos neste navegador/)
    expect((await listProjects()).map((project) => project.id)).toEqual(['three', 'two', 'one'])
  })

  it('allows editing at capacity and adding a project after deletion', async () => {
    await saveProject(createProject('one'))
    await saveProject(createProject('two'))
    await saveProject(createProject('three'))

    await expect(saveProject({ ...createProject('one'), name: 'Projeto atualizado' })).resolves.toHaveLength(3)
    await deleteProject('two')
    await saveProject(createProject('four'))

    expect((await listProjects()).map((project) => project.id)).toEqual(['four', 'one', 'three'])
  })

  it('enforces the project cap when saves race in separate tabs', async () => {
    await saveProject(createProject('one'))
    await saveProject(createProject('two'))

    const results = await Promise.allSettled([
      saveProject(createProject('three')),
      saveProject(createProject('four')),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await listProjects()).toHaveLength(3)
  })

  it('migrates existing localStorage projects without removing any saved projects', async () => {
    const legacy = [createProject('one'), createProject('two'), createProject('three'), createProject('four')]
    values.set('vista.projects.v1', JSON.stringify(legacy))

    expect(await listProjects()).toEqual(legacy)
    expect(values.has('vista.projects.v1')).toBe(false)
    expect(await listProjects()).toEqual(legacy)
  })

  it('stores large row sets as structured data in IndexedDB', async () => {
    const rows = [['Item', 'Quantidade'], ...Array.from({ length: 15_000 }, (_, index) => [`Item ${index}`, String(index)])]
    const project = createProject('large', rows)

    await saveProject(project)

    const saved = await listProjects()
    expect(saved[0].dataset.rows).toHaveLength(15_000)
    expect(saved[0].dataset.rows[14_999]).toEqual(project.dataset.rows[14_999])
  })

  it('validates backup structure and restores without partial writes on limit errors', async () => {
    const existing = [createProject('existing')]
    await restoreProjects(existing, true)
    const backup = createProjectsBackup([createProject('one'), createProject('two'), createProject('three')])

    expect(parseProjectsBackup(backup)).toEqual(backup)
    await expect(restoreProjects(backup.projects, false)).rejects.toThrow(/acima do limite de 3/)
    expect((await listProjects()).map((project) => project.id)).toEqual(['existing'])
    expect(() => parseProjectsBackup({ format: 'other', version: 1, projects: [] })).toThrow(/backup compatível/)
  })

  it('merges and replaces backups atomically', async () => {
    await saveProject(createProject('old'))
    const restored = await restoreProjects([createProject('new')], false)
    expect(restored.map((project) => project.id)).toEqual(['new', 'old'])

    const replaced = await restoreProjects([createProject('replacement')], true)
    expect(replaced.map((project) => project.id)).toEqual(['replacement'])
    expect((await listProjects()).map((project) => project.id)).toEqual(['replacement'])
  })
})
