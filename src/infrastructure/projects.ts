import type { Dataset } from '../domain/dataset'
import type { VisualizationConfig } from '../domain/visualization'

const STORAGE_KEY = 'vista.projects.v1'
export const MAX_LOCAL_PROJECTS = 3

export interface Project {
  id: string
  name: string
  dataset: Dataset
  charts: VisualizationConfig[]
  updatedAt: string
}

export function listProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error('A lista de projetos salva está inválida.')
    return value as Project[]
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Não foi possível ler os projetos salvos no navegador.')
    throw error
  }
}

export function saveProject(project: Project): Project[] {
  const existing = listProjects()
  if (!existing.some((item) => item.id === project.id) && existing.length >= MAX_LOCAL_PROJECTS) {
    throw new Error(`Você pode salvar até ${MAX_LOCAL_PROJECTS} projetos neste navegador. Exclua um projeto existente para salvar outro.`)
  }
  const next = [project, ...existing.filter((item) => item.id !== project.id)]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error('O armazenamento do navegador está cheio. Exporte seus dados e remova projetos antigos.')
    }
    throw error
  }
  return next
}

export function deleteProject(id: string): Project[] {
  const next = listProjects().filter((project) => project.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  return next
}
