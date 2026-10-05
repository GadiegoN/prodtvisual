import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inferDataset } from '../domain/dataset'
import { deleteProject, listProjects, MAX_LOCAL_PROJECTS, saveProject } from './projects'

function createProject(id: string) {
  return {
    id,
    name: id,
    dataset: inferDataset([['Grupo', 'Valor'], ['A', '1']]),
    charts: [],
    updatedAt: new Date().toISOString(),
  }
}

describe('local project storage', () => {
  let values: Map<string, string>

  beforeEach(() => {
    values = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('allows up to three projects and rejects a fourth without changing stored projects', () => {
    saveProject(createProject('one'))
    saveProject(createProject('two'))
    saveProject(createProject('three'))

    expect(MAX_LOCAL_PROJECTS).toBe(3)
    expect(() => saveProject(createProject('four'))).toThrow(/até 3 projetos neste navegador/)
    expect(listProjects().map((project) => project.id)).toEqual(['three', 'two', 'one'])
  })

  it('allows editing an existing project at capacity and adding one after deletion', () => {
    saveProject(createProject('one'))
    saveProject(createProject('two'))
    saveProject(createProject('three'))

    expect(() => saveProject({ ...createProject('one'), name: 'Projeto atualizado' })).not.toThrow()
    deleteProject('two')
    saveProject(createProject('four'))

    expect(listProjects().map((project) => project.id)).toEqual(['four', 'one', 'three'])
  })
})
