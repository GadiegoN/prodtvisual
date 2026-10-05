import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent } from 'react'
import {
  ArrowDownWideNarrow, ArrowLeft, BarChart3, Check, ChevronDown, CircleHelp, Copy, Database,
  Download, FileDown, FileSpreadsheet, Filter, FolderOpen, Grid2X2, HardDrive, LineChart,
  LoaderCircle, Moon, MoreHorizontal, Plus, Save, Search, Share2, Sparkles, Sun, Table2, Trash2, Upload, UserRound,
  WifiOff, X,
} from 'lucide-react'
import { analyzeDataset, inferDataset, isNumericType, parseNumber } from '../domain/dataset'
import type { ColumnType, Dataset, DatasetColumn } from '../domain/dataset'
import { recommendVisualizations } from '../domain/recommendations'
import { calculateStatistics } from '../domain/statistics'
import { defaultVisualization, filteredRows, groupedData } from '../domain/visualization'
import type { Aggregation, DataFilter, FilterOperator, VisualizationConfig } from '../domain/visualization'
import {
  createProjectsBackup, deleteProject, estimateBrowserStorage, listProjects, MAX_LOCAL_PROJECTS,
  parseProjectsBackup, restoreProjects, saveProject,
} from '../infrastructure/projects'
import type { Project } from '../infrastructure/projects'
import { exportCsv as serializeCsv } from '../infrastructure/csvExport'
import { importFile } from '../infrastructure/fileImport'
import { AccountPanel } from './AccountPanel'
import { SharePanel } from './SharePanel'
import {
  apiRequest, createOrganizationProject, deleteOrganizationProject, fetchAuthSession,
  fetchOrganizationProjects, fetchSharedProject, signOut, trackOrganizationExport, updateOrganizationProject,
} from '../infrastructure/saasApi'
import type { AuthSession } from '../infrastructure/saasApi'
import { translate } from './messages'
import type { Locale } from './messages'

type Screen = 'workspace' | 'dashboard' | 'projects'
const ChartView = lazy(() => import('./ChartView').then((module) => ({ default: module.ChartView })))
const ACCOUNT_ACCESS_ENABLED = false
const MAX_BACKUP_BYTES = 100 * 1024 * 1024
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const typeLabels: Record<ColumnType, string> = {
  text: 'Texto', category: 'Categoria', integer: 'Inteiro', decimal: 'Decimal',
  boolean: 'Sim / não', date: 'Data', datetime: 'Data e hora', unknown: 'Detectar automaticamente',
}
const chartIcons: Record<string, typeof BarChart3> = {
  bar: BarChart3, 'bar-horizontal': ArrowDownWideNarrow, line: LineChart, area: LineChart,
  pie: BarChart3, donut: BarChart3, histogram: BarChart3, boxplot: BarChart3, scatter: BarChart3, summary: Grid2X2,
}
const chartNames: Record<VisualizationConfig['type'], string> = {
  bar: 'Colunas', 'bar-horizontal': 'Barras horizontais', line: 'Linha', area: 'Área',
  pie: 'Pizza', donut: 'Donut', histogram: 'Histograma', boxplot: 'Box plot',
  scatter: 'Dispersão', summary: 'Resumo',
}
const aggregationLabels: Record<Aggregation, string> = { sum: 'Soma', average: 'Média', count: 'Contagem', min: 'Mínimo', max: 'Máximo' }
const operatorLabels: Record<FilterOperator, string> = {
  equals: 'é igual a', notEquals: 'não é igual a', contains: 'contém',
  greaterThan: 'é maior que', lessThan: 'é menor que', between: 'está entre',
}
const numericOperators: FilterOperator[] = ['equals', 'notEquals', 'greaterThan', 'lessThan', 'between']
function emptyDataset(): Dataset {
  const columns: DatasetColumn[] = [
    { id: crypto.randomUUID(), name: 'Categoria', type: 'category' },
    { id: crypto.randomUUID(), name: 'Valor', type: 'decimal' },
  ]
  return { columns, rows: Array.from({ length: 4 }, () => Object.fromEntries(columns.map((column) => [column.id, null]))) }
}

function exampleDataset(): Dataset {
  return inferDataset([
    ['Mês', 'Canal', 'Receita', 'Pedidos'],
    ['2026-01-01', 'Loja online', '28.450,00', '164'],
    ['2026-02-01', 'Loja online', '31.820,00', '181'],
    ['2026-03-01', 'Loja online', '29.750,00', '173'],
    ['2026-04-01', 'Loja online', '38.200,00', '212'],
    ['2026-05-01', 'Loja online', '35.480,00', '205'],
    ['2026-06-01', 'Loja online', '42.900,00', '241'],
    ['2026-01-01', 'Revendedores', '19.100,00', '96'],
    ['2026-02-01', 'Revendedores', '22.750,00', '108'],
    ['2026-03-01', 'Revendedores', '20.300,00', '101'],
    ['2026-04-01', 'Revendedores', '25.600,00', '119'],
    ['2026-05-01', 'Revendedores', '27.450,00', '126'],
    ['2026-06-01', 'Revendedores', '30.200,00', '142'],
  ])
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value)
}

function formatStorageSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
}

function createProject(dataset: Dataset, name = 'Projeto sem título'): Project {
  return { id: crypto.randomUUID(), name, dataset, charts: [], updatedAt: new Date().toISOString() }
}

type Theme = 'light' | 'dark'
const THEME_KEY = 'vista.theme.v1'

function getInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function encodeShare(project: Project): string {
  const bytes = new TextEncoder().encode(JSON.stringify(project))
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeShare(value: string): Project | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const project: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!project || typeof project !== 'object' || !('dataset' in project) || !('charts' in project)) return null
    return project as Project
  } catch {
    return null
  }
}

function parseClipboard(text: string): Dataset {
  const delimiter = text.includes('\t') ? '\t' : text.includes(';') ? ';' : ','
  const rows = text.trim().split(/\r?\n/).map((line) => {
    const parsed: string[] = []
    let field = ''
    let quoted = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (char === '"' && line[index + 1] === '"' && quoted) { field += '"'; index += 1 }
      else if (char === '"') quoted = !quoted
      else if (char === delimiter && !quoted) { parsed.push(field.trim()); field = '' }
      else field += char
    }
    parsed.push(field.trim())
    return parsed
  }).filter((row) => row.some((cell) => cell !== ''))
  if (!rows.length) return { columns: [], rows: [] }
  const firstLooksLikeData = rows[0].length > 0 && rows[0].every((cell) =>
    parseNumber(cell) !== null || /^(true|false|sim|não|nao)$/i.test(cell) || /^\d{4}-\d{2}-\d{2}/.test(cell))
  const hasHeader = !firstLooksLikeData
  const source = hasHeader ? rows : [rows[0].map((_, index) => `Coluna ${index + 1}`), ...rows]
  return inferDataset(source)
}

function App() {
  const [locale, setLocale] = useState<Locale>('pt-BR')
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [screen, setScreen] = useState<Screen>('workspace')
  const [project, setProject] = useState<Project>(() => createProject(emptyDataset()))
  const [projects, setProjects] = useState<Project[]>([])
  const [localProjects, setLocalProjects] = useState<Project[]>([])
  const [session, setSession] = useState<AuthSession | null>(null)
  const [activeOrganizationId, setActiveOrganizationId] = useState('')
  const [cloudMode, setCloudMode] = useState(false)
  const [accountOpen, setAccountOpen] = useState(() => ACCOUNT_ACCESS_ENABLED && (location.pathname === '/reset-password' || location.pathname === '/invite'))
  const [shareOpen, setShareOpen] = useState(false)
  const [sharedReadOnly, setSharedReadOnly] = useState(false)
  const [selectedChartId, setSelectedChartId] = useState('')
  const [activeTab, setActiveTab] = useState<'visualize' | 'data'>('visualize')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [storageEstimate, setStorageEstimate] = useState<{ usage?: number; quota?: number }>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const backupFileRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const savedProjectIds = useRef(new Set<string>())
  const cloudProjectIds = useRef(new Set<string>())
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#11131a' : '#f7f8fa',
    )
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    const setOnline = () => setIsOnline(true)
    const setOffline = () => setIsOnline(false)
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('online', setOnline)
    window.addEventListener('offline', setOffline)
    window.addEventListener('beforeinstallprompt', captureInstallPrompt)
    return () => {
      window.removeEventListener('online', setOnline)
      window.removeEventListener('offline', setOffline)
      window.removeEventListener('beforeinstallprompt', captureInstallPrompt)
    }
  }, [])

  useEffect(() => {
    if (screen !== 'projects') return
    void estimateBrowserStorage().then(setStorageEstimate).catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Não foi possível consultar o espaço local disponível.')
    })
  }, [localProjects, screen])

  const profile = useMemo(() => analyzeDataset(project.dataset), [project.dataset])
  const suggestions = useMemo(() => recommendVisualizations(project.dataset, profile), [project.dataset, profile])
  const selectedChart = project.charts.find((chart) => chart.id === selectedChartId) ?? project.charts[0]
  const isSavedProject = savedProjectIds.current.has(project.id) || cloudProjectIds.current.has(project.id)
  const isCloudProject = cloudProjectIds.current.has(project.id)
  const activeOrganization = session?.organizations.find((item) => item.id === activeOrganizationId)
  const queryToken = new URLSearchParams(location.search).get('token')
  const resetToken = location.pathname === '/reset-password' ? queryToken : null
  const invitationToken = location.pathname === '/invite' ? queryToken : null
  const currentRows = useMemo(() => selectedChart ? filteredRows(project.dataset, selectedChart) : project.dataset.rows, [project.dataset, selectedChart])
  const populatedRows = project.dataset.rows.filter((row) => project.dataset.columns.some((column) => row[column.id] !== null && row[column.id] !== ''))
  const currentGroups = useMemo(() => selectedChart ? groupedData(project.dataset, currentRows, selectedChart) : [], [project.dataset, selectedChart])

  useEffect(() => {
    void listProjects().then((saved) => {
      saved.forEach((item) => savedProjectIds.current.add(item.id))
      setLocalProjects(saved)
      setProjects(saved)
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Não foi possível abrir seus projetos.')
    })

    const sharedToken = location.hash.startsWith('#shared=') ? location.hash.slice(8) : ''
    if (sharedToken) {
      setSharedReadOnly(true)
      void fetchSharedProject(sharedToken).then(({ project: shared }) => {
        setProject(shared)
        setSelectedChartId(shared.charts[0]?.id ?? '')
        setNotice('Visualização compartilhada carregada em modo de leitura.')
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : 'Este link de compartilhamento é inválido ou expirou.')
      })
    } else if (location.hash.startsWith('#share=')) {
      const shared = decodeShare(location.hash.slice(7))
      if (shared) {
        setProject(shared)
        setSelectedChartId(shared.charts[0]?.id ?? '')
        setSharedReadOnly(true)
        setNotice('Visualização compartilhada carregada em modo de leitura.')
      } else setError('Este link de compartilhamento não contém um projeto válido.')
    }

    if (!ACCOUNT_ACCESS_ENABLED) return

    const verificationToken = new URLSearchParams(location.search).get('token')
    if (location.pathname === '/verify-email' && verificationToken) {
      void apiRequest<{ verified: boolean }>('/api/auth/verify-email', {
        method: 'POST', body: JSON.stringify({ token: verificationToken }),
      }).then(async () => {
        history.replaceState(null, '', '/')
        await refreshAuthSession()
        setAccountOpen(true)
        setNotice('E-mail verificado. Sua conta está conectada.')
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : 'Não foi possível verificar este e-mail.')
      })
    } else {
      void apiRequest<{ accounts: string }>('/api/health').then(async ({ accounts }) => {
        if (accounts !== 'available') return
        const nextSession = await fetchAuthSession()
        if (!nextSession.user) return
        setSession(nextSession)
        const remembered = localStorage.getItem('vista.organization.v1')
        const organization = nextSession.organizations.find((item) => item.id === remembered) ?? nextSession.organizations[0]
        if (organization) {
          setActiveOrganizationId(organization.id)
          if (localStorage.getItem('vista.storage-mode.v1') === 'cloud') {
            const result = await fetchOrganizationProjects(organization.id)
            cloudProjectIds.current = new Set(result.projects.map((item) => item.id))
            setProjects(result.projects)
            setCloudMode(true)
          }
        }
      }).catch((cause) => {
        if (cause instanceof Error && 'status' in cause && typeof cause.status === 'number' && cause.status >= 500 && cause.status !== 503) {
          setError(cause.message)
        }
      })
    }
  }, [])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 4200)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (sharedReadOnly || !savedProjectIds.current.has(project.id)) return
    const timeout = window.setTimeout(() => {
      void saveProject({ ...project, updatedAt: new Date().toISOString() }).then((next) => {
        setProjects(next)
        setLocalProjects(next)
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : 'Não foi possível salvar as alterações.')
      })
    }, 450)
    return () => window.clearTimeout(timeout)
  }, [project])

  useEffect(() => {
    if (!cloudMode || !activeOrganizationId || !cloudProjectIds.current.has(project.id)) return
    const timeout = window.setTimeout(() => {
      void updateOrganizationProject(project, activeOrganizationId).then(({ project: saved }) => {
        setProjects((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Não foi possível sincronizar o projeto.'))
    }, 650)
    return () => window.clearTimeout(timeout)
  }, [activeOrganizationId, cloudMode, project])

  function updateProject(patch: Partial<Project>) {
    setProject((current) => ({ ...current, ...patch, updatedAt: new Date().toISOString() }))
  }

  function startNew(dataset = emptyDataset(), name = 'Projeto sem título') {
    clearSharedHash()
    const next = createProject(dataset, name)
    setProject(next)
    setSelectedChartId('')
    setScreen('workspace')
    setActiveTab(dataset.rows.length ? 'visualize' : 'data')
    setError('')
    if (dataset.rows.length) createSuggestedChart(next, recommendVisualizations(dataset, analyzeDataset(dataset)))
  }

  function downloadBackup() {
    try {
      if (!localProjects.length) throw new Error('Ainda não há projetos salvos para incluir no backup.')
      const backup = createProjectsBackup(localProjects)
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      if (blob.size > MAX_BACKUP_BYTES) throw new Error('Este backup excede 100 MB. Remova dados ou divida os projetos antes de exportar.')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `vista-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(`Backup criado com ${localProjects.length} projeto(s).`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar o backup.')
    }
  }

  async function restoreBackupFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_BACKUP_BYTES) {
      setError('O backup excede o limite de 100 MB para restauração.')
      return
    }
    try {
      const backup = parseProjectsBackup(JSON.parse(await file.text()) as unknown)
      const replaceExisting = localProjects.length === 0 || window.confirm(
        'Deseja substituir os projetos atuais pelos do backup? Se cancelar, o Vista tentará mesclar os projetos sem apagar os atuais.',
      )
      const restored = await restoreProjects(backup.projects, replaceExisting)
      savedProjectIds.current = new Set(restored.map((item) => item.id))
      setLocalProjects(restored)
      setProjects(restored)
      setCloudMode(false)
      localStorage.setItem('vista.storage-mode.v1', 'local')
      const restoredCurrent = restored.find((item) => item.id === project.id)
      if (restoredCurrent) setProject(restoredCurrent)
      else if (replaceExisting && restored.length) openProject(restored[0])
      setNotice(`${backup.projects.length} projeto(s) restaurado(s) do backup.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível restaurar este backup.')
    }
  }

  async function installApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    const result = await installPrompt.userChoice
    if (result.outcome === 'accepted') setNotice('Vista instalado neste dispositivo.')
    setInstallPrompt(null)
  }

  function createSuggestedChart(base: Project, items = suggestions) {
    const recommendation = items[0]
    if (!recommendation) return
    const config = defaultVisualization(base.dataset, recommendation.type, recommendation.dimensionId, recommendation.metricId)
    const metric = base.dataset.columns.find((column) => column.id === recommendation.metricId)
    const dimension = base.dataset.columns.find((column) => column.id === recommendation.dimensionId)
    if (metric && dimension) config.title = `${metric.name} por ${dimension.name}`
    const next = { ...base, charts: [config], updatedAt: new Date().toISOString() }
    setProject(next)
    setSelectedChartId(config.id)
    setActiveTab('visualize')
  }

  function makeChart(type: VisualizationConfig['type'], dimensionId?: string, metricId?: string, addToDashboard = false) {
    const config = defaultVisualization(project.dataset, type, dimensionId, metricId)
    if (project.charts.length && !addToDashboard && selectedChart) {
      setProject((current) => ({ ...current, charts: current.charts.map((chart) => chart.id === selectedChart.id ? { ...config, id: chart.id } : chart) }))
      setSelectedChartId(selectedChart.id)
    } else {
      setProject((current) => ({ ...current, charts: [...current.charts, config] }))
      setSelectedChartId(config.id)
    }
    setActiveTab('visualize')
  }

  function patchChart(patch: Partial<VisualizationConfig>) {
    if (!selectedChart) return
    setProject((current) => ({ ...current, charts: current.charts.map((chart) => chart.id === selectedChart.id ? { ...chart, ...patch } : chart) }))
  }

  function updateDataset(dataset: Dataset, makeSuggestion = false) {
    const next = { ...project, dataset, updatedAt: new Date().toISOString() }
    setProject(next)
    if (makeSuggestion) createSuggestedChart(next, recommendVisualizations(dataset, analyzeDataset(dataset)))
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const dataset = await importFile(file)
      startNew(dataset, file.name.replace(/\.[^.]+$/, ''))
      setNotice(`${dataset.rows.length} linhas e ${dataset.columns.length} colunas importadas.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível importar este arquivo.')
    } finally {
      setBusy(false)
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (sharedReadOnly) return
    const target = event.target
    const tablePaste = target instanceof HTMLInputElement && Boolean(target.closest('.data-table'))
    if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && !tablePaste) return
    const text = event.clipboardData.getData('text/plain')
    if (!text.includes('\t') && !text.includes('\n') && !(tablePaste && text.includes(';'))) return
    event.preventDefault()
    event.stopPropagation()
    try {
      const dataset = parseClipboard(text)
      if (!dataset.columns.length || !dataset.rows.length) throw new Error('Não foi possível encontrar dados tabulares no conteúdo colado.')
      updateDataset(dataset, true)
      setNotice(`${dataset.rows.length} linhas coladas e analisadas.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível interpretar os dados colados.')
    }
  }

  function createManualTable() {
    updateDataset(emptyDataset())
    setActiveTab('data')
    setScreen('workspace')
    setShowImport(false)
  }

  function addRow() {
    const row = Object.fromEntries(project.dataset.columns.map((column) => [column.id, null]))
    updateDataset({ ...project.dataset, rows: [...project.dataset.rows, row] })
  }

  function addColumn() {
    const index = project.dataset.columns.length + 1
    const column = { id: crypto.randomUUID(), name: `Coluna ${index}`, type: 'unknown' as ColumnType }
    updateDataset({
      columns: [...project.dataset.columns, column],
      rows: project.dataset.rows.map((row) => ({ ...row, [column.id]: null })),
    })
  }

  function updateCell(rowIndex: number, columnId: string, value: string) {
    const rows = [...project.dataset.rows]
    rows[rowIndex] = { ...rows[rowIndex], [columnId]: value === '' ? null : value }
    updateDataset({ ...project.dataset, rows })
  }

  function renameColumn(columnId: string, name: string) {
    updateDataset({ ...project.dataset, columns: project.dataset.columns.map((column) => column.id === columnId ? { ...column, name } : column) })
  }

  function removeColumn(columnId: string) {
    const columns = project.dataset.columns.filter((column) => column.id !== columnId)
    const rows = project.dataset.rows.map((row) => {
      const next = { ...row }
      delete next[columnId]
      return next
    })
    updateDataset({ columns, rows })
    setProject((current) => ({ ...current, charts: current.charts.map((chart) => ({
      ...chart,
      dimensionId: chart.dimensionId === columnId ? columns[0]?.id ?? '' : chart.dimensionId,
      metricId: chart.metricId === columnId ? columns.find((column) => isNumericType(column.type))?.id ?? '' : chart.metricId,
      filters: chart.filters.filter((filter) => filter.columnId !== columnId),
    })) }))
  }

  function duplicateRow(index: number) {
    const row = { ...project.dataset.rows[index] }
    const rows = [...project.dataset.rows]
    rows.splice(index + 1, 0, row)
    updateDataset({ ...project.dataset, rows })
  }

  function addFilter() {
    const column = project.dataset.columns[0]
    if (!column) return
    patchChart({ filters: [...selectedChart.filters, { id: crypto.randomUUID(), columnId: column.id, operator: 'equals', value: '' }] })
  }

  function updateFilter(id: string, patch: Partial<DataFilter>) {
    if (!selectedChart) return
    patchChart({ filters: selectedChart.filters.map((filter) => filter.id === id ? { ...filter, ...patch } : filter) })
  }

  async function saveCurrentProject() {
    if (sharedReadOnly) return
    setSaving(true)
    if (cloudMode && activeOrganizationId) {
      const operation = cloudProjectIds.current.has(project.id)
        ? updateOrganizationProject(project, activeOrganizationId)
        : createOrganizationProject(project, activeOrganizationId)
      void operation.then(({ project: saved }) => {
        cloudProjectIds.current.add(saved.id)
        setProjects((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
        setProject(saved)
        clearSharedHash()
        setNotice(t('saved'))
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o projeto na nuvem.')
      }).finally(() => setSaving(false))
      return
    }
    try {
      const next = await saveProject({ ...project, name: project.name.trim() || 'Projeto sem título', updatedAt: new Date().toISOString() })
      savedProjectIds.current.add(project.id)
      setLocalProjects(next)
      setProjects(next)
      setProject((current) => ({ ...current, name: current.name.trim() || 'Projeto sem título' }))
      clearSharedHash()
      setNotice(t('saved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o projeto.')
    } finally {
      setSaving(false)
    }
  }

  async function refreshAuthSession(preferredOrganizationId?: string): Promise<void> {
    const nextSession = await fetchAuthSession()
    setSession(nextSession)
    const remembered = preferredOrganizationId ?? localStorage.getItem('vista.organization.v1')
    const organization = nextSession.organizations.find((item) => item.id === remembered) ?? nextSession.organizations[0]
    const organizationId = organization?.id ?? ''
    setActiveOrganizationId(organizationId)
    if (organizationId) localStorage.setItem('vista.organization.v1', organizationId)
    else localStorage.removeItem('vista.organization.v1')
    if (organizationId && localStorage.getItem('vista.storage-mode.v1') === 'cloud') {
      const result = await fetchOrganizationProjects(organizationId)
      cloudProjectIds.current = new Set(result.projects.map((item) => item.id))
      setProjects(result.projects)
      setCloudMode(true)
    }
  }

  async function selectOrganization(organizationId: string): Promise<void> {
    const nextSession = await fetchAuthSession()
    if (!nextSession.organizations.some((item) => item.id === organizationId)) {
      throw new Error('Você não tem acesso a essa organização.')
    }
    setSession(nextSession)
    setActiveOrganizationId(organizationId)
    localStorage.setItem('vista.organization.v1', organizationId)
    const result = await fetchOrganizationProjects(organizationId)
    cloudProjectIds.current = new Set(result.projects.map((item) => item.id))
    if (cloudMode) setProjects(result.projects)
  }

  async function changeCloudMode(enabled: boolean): Promise<void> {
    if (enabled) {
      if (!activeOrganizationId) throw new Error('Escolha uma organização antes de ativar a nuvem.')
      const result = await fetchOrganizationProjects(activeOrganizationId)
      cloudProjectIds.current = new Set(result.projects.map((item) => item.id))
      setProjects(result.projects)
      setCloudMode(true)
      localStorage.setItem('vista.storage-mode.v1', 'cloud')
    } else {
      const local = await listProjects()
      setLocalProjects(local)
      setProjects(local)
      setCloudMode(false)
      localStorage.setItem('vista.storage-mode.v1', 'local')
    }
  }

  async function migrateLocalProjects(ids: string[]): Promise<number> {
    if (!activeOrganizationId) throw new Error('Escolha uma organização de destino.')
    const migratedKey = `vista.migrated.${activeOrganizationId}`
    const migrated = new Set((localStorage.getItem(migratedKey) ?? '').split(',').filter(Boolean))
    const selected = localProjects.filter((item) => ids.includes(item.id) && !migrated.has(item.id))
    let imported = 0
    for (const item of selected) {
      try {
        const { project: saved } = await createOrganizationProject(item, activeOrganizationId)
        cloudProjectIds.current.add(saved.id)
        migrated.add(item.id)
        localStorage.setItem(migratedKey, [...migrated].join(','))
        imported += 1
      } catch (cause) {
        const result = await fetchOrganizationProjects(activeOrganizationId)
        cloudProjectIds.current = new Set(result.projects.map((saved) => saved.id))
        setProjects(result.projects)
        const reason = cause instanceof Error ? cause.message : 'erro desconhecido'
        throw new Error(`${imported} projeto(s) foram copiados. “${item.name}” não foi importado: ${reason}. Os originais locais foram preservados.`)
      }
    }
    const result = await fetchOrganizationProjects(activeOrganizationId)
    cloudProjectIds.current = new Set(result.projects.map((item) => item.id))
    setProjects(result.projects)
    setCloudMode(true)
    localStorage.setItem('vista.storage-mode.v1', 'cloud')
    return imported
  }

  async function leaveAccount(): Promise<void> {
    await signOut()
    setSession(null)
    setActiveOrganizationId('')
    setCloudMode(false)
    cloudProjectIds.current.clear()
    localStorage.removeItem('vista.storage-mode.v1')
    const saved = await listProjects()
    setLocalProjects(saved)
    setProjects(saved)
  }

  function openProject(item: Project) {
    setSharedReadOnly(false)
    clearSharedHash()
    setProject(item)
    setSelectedChartId(item.charts[0]?.id ?? '')
    setScreen('workspace')
    setActiveTab(item.charts.length ? 'visualize' : 'data')
    setError('')
  }

  async function duplicateProject(item: Project) {
    const duplicate = { ...item, id: crypto.randomUUID(), name: `${item.name} — cópia`, updatedAt: new Date().toISOString() }
    if (cloudMode && activeOrganizationId) {
      void createOrganizationProject(duplicate, activeOrganizationId).then(({ project: saved }) => {
        cloudProjectIds.current.add(saved.id)
        setProjects((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
        setNotice('Uma cópia do projeto foi criada na nuvem.')
      }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Não foi possível duplicar o projeto.'))
      return
    }
    try {
      const next = await saveProject(duplicate)
      savedProjectIds.current.add(duplicate.id)
      setLocalProjects(next)
      setProjects(next)
      setNotice('Uma cópia do projeto foi criada.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível duplicar o projeto.')
    }
  }

  async function removeProject(id: string) {
    if (sharedReadOnly) return
    if (!window.confirm('Excluir este projeto salvo? Esta ação não pode ser desfeita.')) return
    if (cloudMode && cloudProjectIds.current.has(id) && activeOrganizationId) {
      void deleteOrganizationProject(id, activeOrganizationId).then(() => {
        cloudProjectIds.current.delete(id)
        setProjects((current) => current.filter((item) => item.id !== id))
        if (project.id === id) startNew()
      }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Não foi possível excluir o projeto.'))
      return
    }
    try {
      const next = await deleteProject(id)
      setLocalProjects(next)
      setProjects(next)
      if (project.id === id) startNew()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível excluir o projeto.')
    }
  }

  async function shareProject() {
    if (sharedReadOnly) return
    if (activeOrganizationId && isCloudProject) {
      setShareOpen(true)
      return
    }
    if (cloudMode && activeOrganizationId) {
      if (!cloudProjectIds.current.has(project.id)) {
        setError('Salve o projeto na nuvem antes de criar um link seguro.')
        return
      }
    }
    const url = `${location.origin}${location.pathname}#share=${encodeShare(project)}`
    try {
      await navigator.clipboard.writeText(url)
      setNotice('Link copiado. Ele contém os dados do projeto; compartilhe apenas com pessoas autorizadas.')
    } catch {
      setError('Não foi possível copiar o link. Verifique a permissão da área de transferência.')
    }
  }

  async function trackExport(format: 'csv' | 'png' | 'svg' | 'pdf'): Promise<boolean> {
    if ((!cloudMode && !cloudProjectIds.current.has(project.id)) || !activeOrganizationId) return true
    try {
      await trackOrganizationExport(format, activeOrganizationId)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível autorizar esta exportação.')
      return false
    }
  }

  async function exportCsv() {
    if (!selectedChart) return
    if (!await trackExport('csv')) return
    const rows = filteredRows(project.dataset, selectedChart)
    download(new Blob([serializeCsv(project.dataset, rows)], { type: 'text/csv;charset=utf-8' }), `${project.name}-dados.csv`)
  }

  async function exportChart(format: 'svg' | 'png' | 'pdf') {
    if (format === 'pdf') {
      if (await trackExport('pdf')) window.print()
      return
    }
    let svg = canvasRef.current?.querySelector('svg') ?? null
    if (!svg && selectedChart?.type === 'summary') {
      const cards = [...(canvasRef.current?.querySelectorAll('.chart-stat') ?? [])]
      const columns = 3
      const cardWidth = 245
      const cardHeight = 88
      const gap = 12
      const rows = Math.ceil(cards.length / columns)
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', `0 0 ${columns * cardWidth + (columns + 1) * gap} ${rows * cardHeight + (rows + 1) * gap}`)
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      svg.setAttribute('role', 'img')
      svg.setAttribute('aria-label', selectedChart.title)
      cards.forEach((card, index) => {
        const x = gap + (index % columns) * (cardWidth + gap)
        const y = gap + Math.floor(index / columns) * (cardHeight + gap)
        const rect = document.createElementNS(svg!.namespaceURI, 'rect')
        rect.setAttribute('x', String(x))
        rect.setAttribute('y', String(y))
        rect.setAttribute('width', String(cardWidth))
        rect.setAttribute('height', String(cardHeight))
        rect.setAttribute('rx', '10')
        rect.setAttribute('fill', '#fcfcfe')
        rect.setAttribute('stroke', '#e9eaf0')
        svg!.appendChild(rect)
        const texts = [...card.querySelectorAll('span, strong')]
        texts.forEach((node, textIndex) => {
          const text = document.createElementNS(svg!.namespaceURI, 'text')
          text.setAttribute('x', String(x + 14))
          text.setAttribute('y', String(y + (textIndex === 0 ? 28 : 59)))
          text.setAttribute('fill', textIndex === 0 ? '#777a89' : '#343646')
          text.setAttribute('font-family', 'Arial, sans-serif')
          text.setAttribute('font-size', textIndex === 0 ? '13' : '20')
          text.textContent = node.textContent ?? ''
          svg!.appendChild(text)
        })
      })
    }
    if (!svg) {
      setError('Este cartão não possui um gráfico vetorial para exportar. Escolha uma visualização gráfica.')
      return
    }
    if (!await trackExport(format)) return
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement
      const rect = svg.getBoundingClientRect()
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      clone.setAttribute('width', String(Math.max(800, Math.round(rect.width))))
      clone.setAttribute('height', String(Math.max(450, Math.round(rect.height))))
      const serialized = new XMLSerializer().serializeToString(clone)
      if (format === 'svg') {
        download(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }), `${selectedChart?.title || 'visualizacao'}.svg`)
      } else {
        const image = new Image()
        const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }))
        image.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(800, Math.round(rect.width)) * 2
          canvas.height = Math.max(450, Math.round(rect.height)) * 2
          const context = canvas.getContext('2d')
          if (!context) { URL.revokeObjectURL(url); setError('Não foi possível iniciar o canvas para exportação.'); return }
          context.scale(2, 2)
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, canvas.width / 2, canvas.height / 2)
          context.drawImage(image, 0, 0, canvas.width / 2, canvas.height / 2)
          canvas.toBlob((blob) => {
            URL.revokeObjectURL(url)
            if (!blob) { setError('Não foi possível gerar a imagem PNG.'); return }
            download(blob, `${selectedChart?.title || 'visualizacao'}.png`)
          }, 'image/png')
        }
        image.onerror = () => { URL.revokeObjectURL(url); setError('Não foi possível converter o gráfico em PNG.') }
        image.src = url
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao exportar a visualização.')
    }
  }

  function download(blob: Blob, filename: string) {
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    link.href = url
    link.download = filename
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function renameProject(name: string) {
    updateProject({ name })
  }

  function clearSharedHash() {
    if (location.hash.startsWith('#share=') || location.hash.startsWith('#shared=')) history.replaceState(null, '', `${location.pathname}${location.search}`)
  }

  const displayedProjects = projects.filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const numericColumns = project.dataset.columns.filter((column) => isNumericType(column.type))
  const suggestedStats = selectedChart ? calculateStatistics(selectedChart.metricId ? currentRows.map((row) => row[selectedChart.metricId]) : currentRows.map(() => 1)) : null
  const categoryCounts = selectedChart?.dimensionId ? new Set(currentRows.map((row) => String(row[selectedChart.dimensionId]))).size : 0
  const insight = selectedChart && currentGroups.length > 1
    ? (() => {
      const dimension = project.dataset.columns.find((column) => column.id === selectedChart.dimensionId)
      const metricName = project.dataset.columns.find((column) => column.id === selectedChart.metricId)?.name ?? 'registros'
      if (dimension && ['date', 'datetime'].includes(dimension.type)) {
        const first = currentGroups[0]
        const last = currentGroups[currentGroups.length - 1]
        if (first.value !== 0) {
          const change = ((last.value - first.value) / Math.abs(first.value)) * 100
          return `De ${first.name} a ${last.name}, ${metricName} ${change >= 0 ? 'cresceu' : 'caiu'} ${formatNumber(Math.abs(change))}%.`
        }
      }
      if (!dimension) return null
      const highest = currentGroups.reduce((best, item) => item.value > best.value ? item : best)
      return `${highest.name} apresenta o maior valor de ${metricName}: ${formatNumber(highest.value)}.`
    })()
    : null
  const migrationProjects = localProjects.filter((item) => !localStorage.getItem(`vista.migrated.${activeOrganizationId}`)?.split(',').includes(item.id))
  return <div
    className={`app-shell ${sharedReadOnly ? 'shared-readonly' : ''}`}
    onPaste={handlePaste}
    onClickCapture={(event) => {
      if (sharedReadOnly) { event.preventDefault(); event.stopPropagation() }
    }}
    onChangeCapture={(event) => {
      if (sharedReadOnly) { event.preventDefault(); event.stopPropagation() }
    }}
  >
    <aside className="sidebar">
      <button className="brand" onClick={() => { setScreen('workspace'); setActiveTab('visualize') }} aria-label="Vista, início">
        <span className="brand-mark"><BarChart3 size={21} strokeWidth={2.5} /></span><span>vista<span className="brand-dot">.</span></span>
      </button>
      {ACCOUNT_ACCESS_ENABLED
        ? <button className="sidebar-workspace" onClick={() => setAccountOpen(true)}><div className="workspace-avatar">{(activeOrganization?.name ?? 'V').slice(0, 1).toLocaleUpperCase()}</div><div><strong>{activeOrganization?.name ?? 'Meu espaço'}</strong><span>{activeOrganization ? `${activeOrganization.planId} · ${activeOrganization.role}` : session?.user ? 'Escolha um workspace' : 'Plano local'}</span></div><ChevronDown size={15} /></button>
        : <div className="sidebar-workspace"><div className="workspace-avatar">V</div><div><strong>Meu espaço</strong><span>Plano local</span></div></div>}
      <div className="side-label">ESPAÇO DE TRABALHO</div>
      <nav className="side-nav" aria-label="Navegação principal">
        <button className={screen === 'workspace' ? 'selected' : ''} onClick={() => { setScreen('workspace'); setActiveTab('visualize') }}><Sparkles size={17} />{t('create')}</button>
        <button className={screen === 'dashboard' ? 'selected' : ''} onClick={() => setScreen('dashboard')}><Grid2X2 size={17} />{t('dashboard')}</button>
        <button className={screen === 'projects' ? 'selected' : ''} onClick={() => setScreen('projects')}><FolderOpen size={17} />{t('projects')}<span className="nav-count">{projects.length || ''}</span></button>
      </nav>
      <div className="side-divider" />
      <div className="side-label">RECENTE</div>
      <div className="recent-list">
        {projects.slice(0, 4).map((item) => <button key={item.id} className="recent-item" onClick={() => openProject(item)}><span className="recent-icon"><BarChart3 size={14} /></span><span>{item.name}</span></button>)}
        {!projects.length && <span className="recent-empty">Seus projetos salvos aparecerão aqui.</span>}
      </div>
      <div className="sidebar-bottom">
        <div className="help-card"><div className="help-icon"><CircleHelp size={16} /></div><strong>Precisa de ajuda?</strong><span>Cole seus dados ou importe uma planilha para começar.</span></div>
        {ACCOUNT_ACCESS_ENABLED
          ? <button className="sidebar-profile" onClick={() => setAccountOpen(true)}><div className="profile-avatar">{session?.user ? session.user.name.slice(0, 1).toLocaleUpperCase() : 'G'}</div><div><strong>{session?.user?.name ?? 'Meu espaço'}</strong><span>{session?.user?.email ?? 'Conta local'}</span></div><MoreHorizontal size={18} /></button>
          : <div className="sidebar-profile"><div className="profile-avatar">G</div><div><strong>Meu espaço</strong><span>Conta local</span></div></div>}
      </div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="breadcrumbs"><span>{activeOrganization?.name ?? 'Meu espaço'}</span><span className="breadcrumb-slash">/</span><strong>{screen === 'projects' ? t('projects') : screen === 'dashboard' ? t('dashboard') : project.name}</strong></div>
        <div className="top-actions">
          <label className="locale-picker" aria-label={t('language')}><span>◉</span><select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}><option value="pt-BR">PT</option><option value="en-US">EN</option></select></label>
          <button
            className="button button-quiet button-small theme-toggle"
            onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'}
            title={theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            <span>{theme === 'dark' ? 'Claro' : 'Escuro'}</span>
          </button>
          {installPrompt && <button className="button button-quiet button-small install-app-button" onClick={() => void installApp()}><Download size={15} /><span>Instalar</span></button>}
          {ACCOUNT_ACCESS_ENABLED && <button className="button button-quiet button-small" onClick={() => setAccountOpen(true)}><UserRound size={15} /><span>{session?.user ? 'Conta' : 'Entrar'}</span></button>}
          {!sharedReadOnly && <button className="button button-quiet button-small" onClick={shareProject} title="Criar link de compartilhamento"><Share2 size={15} /><span>Compartilhar</span></button>}
          {!sharedReadOnly && <button className="button button-primary button-small" onClick={saveCurrentProject} disabled={saving || !project.dataset.columns.length} title={!cloudMode && !savedProjectIds.current.has(project.id) && localProjects.length >= MAX_LOCAL_PROJECTS ? `Limite de ${MAX_LOCAL_PROJECTS} projetos por navegador` : undefined}><Save size={15} />{saving ? 'Salvando…' : t('save')}</button>}
          <button className="button icon-button mobile-menu" onClick={() => setScreen('projects')} aria-label="Abrir projetos"><FolderOpen size={18} /></button>
        </div>
      </header>

      {!isOnline && <div className="offline-banner" role="status"><WifiOff size={15} /><span>Sem conexão. O Vista continua disponível com os arquivos já carregados; seus projetos permanecem salvos neste navegador.</span></div>}
      {(error || notice) && <div className={`toast ${error ? 'toast-error' : 'toast-success'}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button onClick={() => { setError(''); setNotice('') }} aria-label="Fechar aviso"><X size={15} /></button></div>}

      {screen === 'projects' ? <section className="page-content projects-page">
        <div className="page-heading"><div><div className="eyebrow">SUA BIBLIOTECA</div><h1>Seus projetos</h1><p>Retome suas análises de onde parou.</p><p className="local-project-limit">Projetos neste navegador: {localProjects.length}/{MAX_LOCAL_PROJECTS}. Eles ficam salvos apenas neste navegador; crie backups para transferir ou proteger seus dados.</p>{storageEstimate.quota !== undefined && <p className="local-storage-usage"><HardDrive size={13} /> Uso estimado pelo site: {formatStorageSize(storageEstimate.usage ?? 0)} (cota informada pelo navegador: {formatStorageSize(storageEstimate.quota)}).</p>}</div><div className="project-heading-actions"><button className="button button-secondary" onClick={downloadBackup} disabled={!localProjects.length}><Download size={15} />Baixar backup</button><button className="button button-secondary" onClick={() => backupFileRef.current?.click()}><Upload size={15} />Restaurar backup</button><input ref={backupFileRef} type="file" accept=".json,application/json" hidden onChange={(event) => void restoreBackupFile(event)} /><button className="button button-primary" onClick={() => startNew()}><Plus size={17} />{t('createNew')}</button></div></div>
        <div className="project-search"><Search size={16} /><input aria-label="Buscar projetos" placeholder="Buscar projetos..." value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        {displayedProjects.length ? <div className="project-grid">{displayedProjects.map((item) => <article className="project-card" key={item.id}>
          <button className="project-card-main" onClick={() => openProject(item)}><div className="project-preview"><div className="preview-bars"><i /><i /><i /><i /><i /><i /></div><div className="preview-line" /></div><div className="project-card-body"><div className="project-card-icon"><BarChart3 size={16} /></div><div className="project-card-title"><strong>{item.name}</strong><span>{item.dataset.rows.length} linhas · {item.dataset.columns.length} colunas</span></div><span className="project-card-date">{new Date(item.updatedAt).toLocaleDateString('pt-BR')}</span></div></button>
          <div className="project-card-actions"><button onClick={() => duplicateProject(item)}><Copy size={14} />Duplicar</button><button onClick={() => removeProject(item.id)}><Trash2 size={14} />Excluir</button></div>
        </article>)}</div> : <div className="empty-projects"><div className="empty-illustration"><FolderOpen size={28} /></div><h2>{search ? 'Nenhum projeto encontrado' : 'Sua biblioteca está vazia'}</h2><p>{search ? 'Tente buscar por outro nome.' : 'Salve uma visualização para encontrá-la aqui quando quiser.'}</p>{!search && <button className="button button-secondary" onClick={() => startNew()}><Plus size={16} />Criar primeiro projeto</button>}</div>}
      </section> : screen === 'dashboard' ? <section className="page-content dashboard-page">
        <div className="page-heading"><div><div className="eyebrow">VISÃO GERAL DO PROJETO</div><input className="editable-heading" aria-label="Nome do projeto" value={project.name} onChange={(event) => renameProject(event.target.value)} onBlur={() => { if (!project.name.trim()) renameProject('Projeto sem título') }} /><p>Organize as visualizações mais importantes em um só lugar.</p></div><div className="heading-actions"><button className="button button-secondary" onClick={() => setScreen('workspace')}><ArrowLeft size={16} />Voltar ao editor</button><button className="button button-primary" onClick={() => setScreen('workspace')}><Plus size={16} />Adicionar visualização</button></div></div>
        <Dashboard dataset={project.dataset} charts={project.charts} onOpen={(id) => { setSelectedChartId(id); setScreen('workspace'); setActiveTab('visualize') }} onRemove={(id) => { setProject((current) => ({ ...current, charts: current.charts.filter((chart) => chart.id !== id) })); if (selectedChartId === id) setSelectedChartId('') }} onResize={(id) => setProject((current) => ({ ...current, charts: current.charts.map((chart) => chart.id === id ? { ...chart, size: chart.size === 'wide' ? 'normal' : 'wide' } : chart) }))} onMove={(id, direction) => {
          const index = project.charts.findIndex((chart) => chart.id === id)
          const target = index + direction
          if (index < 0 || target < 0 || target >= project.charts.length) return
          const charts = [...project.charts]
          ;[charts[index], charts[target]] = [charts[target], charts[index]]
          updateProject({ charts })
        }} />
      </section> : <div className="workspace">
        <div className="workspace-heading">
          <div className="workspace-title-row"><div className="title-icon"><Sparkles size={19} /></div><div><div className="eyebrow">ESTÚDIO DE DADOS</div><input className="project-name-input" aria-label="Nome do projeto" value={project.name} onChange={(event) => renameProject(event.target.value)} onBlur={() => { if (!project.name.trim()) renameProject('Projeto sem título') }} /></div></div>
          <div className="project-meta"><span><span className="status-dot" />{isCloudProject ? 'Salvo na nuvem' : savedProjectIds.current.has(project.id) ? 'Salvo localmente' : 'Rascunho neste navegador'}</span><span>·</span><span>{isCloudProject ? cloudMode ? 'Alterações sincronizadas automaticamente' : 'Sincronização da nuvem pausada' : isSavedProject ? 'Alterações salvas automaticamente' : 'Salve para voltar a este projeto'}</span></div>
        </div>
        <div className="content-tabs">
          <button className={activeTab === 'visualize' ? 'active' : ''} onClick={() => setActiveTab('visualize')}><Sparkles size={15} />Visualizar{project.charts.length > 0 && <span className="tab-count">{project.charts.length}</span>}</button>
          <button className={activeTab === 'data' ? 'active' : ''} onClick={() => setActiveTab('data')}><Table2 size={15} />{t('data')}<span className="tab-count">{profile.rowCount}</span></button>
          {activeTab === 'visualize' && project.charts.length > 1 && <div className="chart-tabs" role="tablist" aria-label="Visualizações deste projeto">{project.charts.map((chart, index) => <button role="tab" aria-selected={selectedChart?.id === chart.id} className={selectedChart?.id === chart.id ? 'current' : ''} key={chart.id} onClick={() => setSelectedChartId(chart.id)}>{chart.title || `Visualização ${index + 1}`}</button>)}</div>}
        </div>

        {activeTab === 'data' ? <section className="data-workspace">
          <div className="section-topline"><div><h2>Seus dados</h2><p>Adicione uma tabela, cole dados de uma planilha ou importe um arquivo.</p></div><div className="data-actions"><button className="button button-secondary button-small" onClick={() => setShowImport(!showImport)}><Upload size={15} />{t('import')}</button><label className="button button-secondary button-small file-trigger"><FileSpreadsheet size={15} />Escolher arquivo<input ref={fileRef} type="file" accept=".csv,.json,.xlsx,.xls" onChange={handleFile} /></label></div></div>
          {showImport && <div className="import-panel"><div className="import-panel-icon"><FileDown size={19} /></div><div><strong>Importe uma tabela</strong><p>CSV, JSON ou Excel (.xlsx). Arquivos de até 20 MB.</p></div><button className="button button-primary button-small" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}{busy ? 'Importando…' : 'Selecionar arquivo'}</button><button className="icon-button" onClick={() => setShowImport(false)} aria-label="Fechar importação"><X size={16} /></button></div>}
          {!project.dataset.columns.length && <div className="empty-data"><Database size={25} /><strong>Comece com uma tabela</strong><span>Adicione colunas manualmente ou cole os dados copiados da planilha.</span><button className="button button-primary button-small" onClick={createManualTable}><Plus size={15} />Criar tabela</button></div>}
          {project.dataset.columns.length > 0 && <DataEditor dataset={project.dataset} profile={profile} onCell={updateCell} onRename={renameColumn} onType={(id, type) => updateDataset({ ...project.dataset, columns: project.dataset.columns.map((column) => column.id === id ? { ...column, type } : column) })} onAddRow={addRow} onAddColumn={addColumn} onRemoveColumn={removeColumn} onRemoveRow={(index) => updateDataset({ ...project.dataset, rows: project.dataset.rows.filter((_, rowIndex) => rowIndex !== index) })} onDuplicateRow={duplicateRow} onClear={() => {
            if (!window.confirm('Limpar todos os dados da tabela?')) return
            updateDataset({ ...project.dataset, rows: [] })
          }} onPaste={handlePaste} /> }
          {project.dataset.columns.length > 0 && <div className="data-footer"><span>{profile.rowCount} linhas · {profile.columnCount} colunas · {profile.missingCells} valores vazios</span><button className="text-button danger-text" onClick={() => {
            if (!window.confirm('Limpar os dados de todas as células?')) return
            updateDataset({ ...project.dataset, rows: [] })
          }}><Trash2 size={14} />Limpar tabela</button></div>}
          <div className="paste-hint"><span className="paste-shortcut">⌘ V</span> Dica: copie células de qualquer planilha e cole diretamente na tabela.</div>
        </section> : <>
          {!project.dataset.columns.length || populatedRows.length === 0 ? <div className="empty-workspace">
            <div className="hero-graphic"><div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" /><div className="hero-chart"><BarChart3 size={38} strokeWidth={1.6} /></div><span className="hero-spark spark-one">✳</span><span className="hero-spark spark-two">✧</span></div>
            <div className="eyebrow">DADOS EM CLAREZA</div><h1>Transforme seus dados<br />em <span>boas decisões.</span></h1><p>Comece com uma planilha ou experimente usando dados de exemplo. Nós ajudamos a encontrar a visualização certa.</p>
            <div className="empty-actions"><button className="button button-primary button-large" onClick={() => { setActiveTab('data'); setShowImport(true) }}><Plus size={17} />{t('create')}</button><button className="button button-secondary button-large" onClick={() => startNew(exampleDataset(), 'Análise de receita')}><Sparkles size={17} />{t('sample')}</button></div>
            <button className="paste-link" onClick={() => setActiveTab('data')}><Table2 size={15} />ou cole uma tabela na área de dados</button>
          </div> : <div className="analysis-layout">
            <div className="analysis-main">
              <section className="data-summary-card">
                <div className="summary-header"><div><div className="eyebrow">ANÁLISE DOS DADOS</div><h2>Entenda sua tabela</h2></div><button className="button button-quiet button-small" onClick={() => setActiveTab('data')}><Table2 size={14} />Ver tabela</button></div>
                <div className="summary-metrics">
                  <div><span>Linhas</span><strong>{formatNumber(profile.rowCount)}</strong></div><div><span>Colunas</span><strong>{formatNumber(profile.columnCount)}</strong></div><div><span>Valores vazios</span><strong>{formatNumber(profile.missingCells)}</strong></div>
                </div>
                <div className="column-list">{profile.columns.map((item) => <div className="column-item" key={item.column.id}><span className={`column-kind kind-${item.column.type}`}>{isNumericType(item.column.type) ? '123' : ['date', 'datetime'].includes(item.column.type) ? '◷' : 'Aa'}</span><strong>{item.column.name}</strong><span className="column-type-text">{typeLabels[item.column.type]}</span><span className="column-unique">{item.unique} distintos</span>{item.missing > 0 && <span className="missing-tag">{item.missing} vazios</span>}{item.invalid > 0 && <span className="invalid-tag">{item.invalid} inválidos</span>}</div>)}</div>
                {profile.warnings.length > 0 && <div className="quality-notice"><CircleHelp size={15} /><span>{profile.warnings.join(' · ')}</span></div>}
              </section>

              <section className="suggestion-section">
                <div className="section-title-row"><div><div className="eyebrow">FEITO PARA SEUS DADOS</div><h2>Por onde começar?</h2><p>As sugestões abaixo usam os tipos e valores que encontramos na tabela.</p></div><span className="ai-badge"><Sparkles size={13} />Sugestões inteligentes</span></div>
                {suggestions.length > 0 ? <div className="suggestion-grid">{suggestions.map((suggestion, index) => {
                  const Icon = chartIcons[suggestion.type] ?? BarChart3
                  return <button className={`suggestion-card ${index === 0 ? 'suggestion-featured' : ''}`} key={`${suggestion.type}-${suggestion.metricId}-${suggestion.dimensionId}`} onClick={() => makeChart(suggestion.type, suggestion.dimensionId, suggestion.metricId, true)}>
                    <div className="suggestion-card-top"><span className="suggestion-icon"><Icon size={18} /></span>{index === 0 && <span className="recommended-pill"><Sparkles size={11} />Recomendada</span>}<span className="suggestion-arrow">↗</span></div><strong>{suggestion.title}</strong><span>{suggestion.description}</span><div className="suggestion-score"><i style={{ width: `${suggestion.score * 100}%` }} /></div>
                  </button>
                })}</div> : <div className="no-suggestions"><BarChart3 size={20} /><div><strong>Ainda não encontramos uma visualização adequada.</strong><span>Adicione mais dados ou ajuste os tipos das colunas para ver sugestões.</span></div><button className="button button-secondary button-small" onClick={() => setActiveTab('data')}>Revisar dados</button></div>}
              </section>

              {selectedChart && <section className="visualization-section">
                <div className="visualization-heading"><div><div className="eyebrow">SUA VISUALIZAÇÃO</div><h2>Personalize o resultado</h2></div><div className="visualization-actions"><ExportMenu onExport={exportChart} onCsv={exportCsv} /><button className="button button-primary button-small" onClick={() => setScreen('dashboard')}><Grid2X2 size={15} />Abrir painel</button></div></div>
                <div className="editor-grid">
                  <ChartEditor dataset={project.dataset} config={selectedChart} onChange={patchChart} onAddFilter={addFilter} onUpdateFilter={updateFilter} />
                  <div className="chart-result-card">
                    <div className="chart-card-heading"><div><h3>{selectedChart.title || 'Sem título'}</h3>{selectedChart.subtitle && <p>{selectedChart.subtitle}</p>}<span>{currentRows.length} de {profile.rowCount} linhas</span></div><button className="icon-button" aria-label="Exportar gráfico" onClick={() => exportChart('png')}><Download size={17} /></button></div>
                    <div className="chart-canvas" ref={canvasRef}><Suspense fallback={<div className="chart-empty"><LoaderCircle className="spin" size={20} />Preparando visualização…</div>}><ChartView dataset={project.dataset} config={selectedChart} /></Suspense></div>
                    {suggestedStats && <div className="chart-insight"><span className="insight-icon"><Sparkles size={14} /></span><span>{insight ?? `${selectedChart.metricId ? `${selectedChart.aggregation === 'average' ? 'Média' : selectedChart.aggregation === 'count' ? 'Contagem' : 'Total'} de ${project.dataset.columns.find((column) => column.id === selectedChart.metricId)?.name}: ` : 'Registros analisados: '}${selectedChart.aggregation === 'average' ? formatNumber(suggestedStats.average) : selectedChart.aggregation === 'count' ? formatNumber(suggestedStats.count) : formatNumber(suggestedStats.sum)}${categoryCounts > 1 ? ` · ${categoryCounts} categorias` : ''}`}</span></div>}
                  </div>
                </div>
              </section>}
            </div>
            <aside className="inspector"><div className="inspector-title"><div><span className="eyebrow">SEU DATASET</span><h3>Qualidade dos dados</h3></div><span className="quality-score"><Check size={13} />{profile.missingCells ? 'Revisar' : 'Ótima'}</span></div>
              <div className="quality-meter"><span style={{ width: `${Math.max(6, Math.round((1 - profile.missingCells / Math.max(profile.rowCount * profile.columnCount, 1)) * 100))}%` }} /></div>
              <p className="inspector-copy">{profile.missingCells ? `${profile.missingCells} células vazias podem afetar algumas visualizações.` : 'Sua tabela está pronta para ser explorada.'}</p>
              <div className="inspector-divider" />
              <div className="inspector-title"><div><span className="eyebrow">RESUMO RÁPIDO</span><h3>Colunas numéricas</h3></div><span className="inspector-count">{numericColumns.length}</span></div>
              {numericColumns.length ? numericColumns.map((column) => {
                const item = profile.columns.find((entry) => entry.column.id === column.id)
                return <div className="mini-stat" key={column.id}><span><i />{column.name}</span><strong>{item?.mean === undefined ? '—' : formatNumber(item.mean)}</strong><small>média</small></div>
              }) : <div className="inspector-empty">Nenhuma medida numérica detectada.</div>}
              <div className="inspector-divider" />
              <button className="inspector-action" onClick={() => setActiveTab('data')}><Table2 size={15} />Revisar tipos das colunas<ChevronDown size={14} /></button>
              <button className="inspector-action" onClick={() => setScreen('dashboard')}><Grid2X2 size={15} />Abrir painel de visualizações<ChevronDown size={14} /></button>
            </aside>
          </div>}
        </>}
      </div>}
    </main>
    {ACCOUNT_ACCESS_ENABLED && <AccountPanel
      open={accountOpen}
      session={session}
      activeOrganizationId={activeOrganizationId}
      resetToken={resetToken}
      invitationToken={invitationToken}
      localProjects={migrationProjects}
      cloudMode={cloudMode}
      onClose={() => setAccountOpen(false)}
      onAuthenticated={() => refreshAuthSession()}
      onSignedOut={leaveAccount}
      onSelectOrganization={selectOrganization}
      onCloudModeChange={changeCloudMode}
      onMigrate={async (ids) => {
        const imported = await migrateLocalProjects(ids)
        return imported
      }}
    />}
    {activeOrganizationId && <SharePanel
      open={shareOpen}
      projectId={project.id}
      organizationId={activeOrganizationId}
      onClose={() => setShareOpen(false)}
    />}
  </div>
}

export default App

interface DataEditorProps {
  dataset: Dataset
  profile: ReturnType<typeof analyzeDataset>
  onCell: (row: number, column: string, value: string) => void
  onRename: (id: string, name: string) => void
  onType: (id: string, type: ColumnType) => void
  onAddRow: () => void
  onAddColumn: () => void
  onRemoveColumn: (id: string) => void
  onRemoveRow: (index: number) => void
  onDuplicateRow: (index: number) => void
  onClear: () => void
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
}

function DataEditor({ dataset, profile, onCell, onRename, onType, onAddRow, onAddColumn, onRemoveColumn, onRemoveRow, onDuplicateRow, onClear, onPaste }: DataEditorProps) {
  const [menuRow, setMenuRow] = useState<number | null>(null)
  const [page, setPage] = useState(0)
  const pageSize = 50
  const activePage = Math.min(page, Math.max(0, Math.ceil(dataset.rows.length / pageSize) - 1))
  const rowOffset = activePage * pageSize
  const rows = dataset.rows.slice(rowOffset, rowOffset + pageSize)
  return <div className="table-frame" onPaste={onPaste}>
    <div className="table-tools"><div className="table-tool-left"><span className="table-status-dot" /><strong>Tabela de dados</strong><span>{profile.rowCount > 50 ? 'Tabela paginada para facilitar a edição' : `${profile.rowCount} registros`}</span></div><div className="table-tool-right"><button className="text-button" onClick={onClear}><Trash2 size={14} />Limpar dados</button><button className="button button-secondary button-small" onClick={onAddColumn}><Plus size={14} />{translate('pt-BR', 'addColumn')}</button><button className="button button-primary button-small" onClick={onAddRow}><Plus size={14} />{translate('pt-BR', 'addRow')}</button></div></div>
    <div className="table-scroll"><table className="data-table"><thead><tr><th className="row-number-cell">#</th>{dataset.columns.map((column) => <th key={column.id}><div className="column-header"><input className="column-name-input" aria-label={`Nome da coluna ${column.name}`} value={column.name} onChange={(event) => onRename(column.id, event.target.value)} /><select value={column.type} aria-label={`Tipo da coluna ${column.name}`} onChange={(event) => onType(column.id, event.target.value as ColumnType)}>{Object.entries(typeLabels).map(([type, label]) => <option value={type} key={type}>{label}</option>)}</select><button className="column-delete" onClick={() => onRemoveColumn(column.id)} aria-label={`Excluir coluna ${column.name}`}><X size={14} /></button></div></th>)}<th className="add-column-cell"><button onClick={onAddColumn} aria-label="Adicionar coluna"><Plus size={16} /></button></th></tr></thead>
      <tbody>{rows.map((row, rowIndex) => { const absoluteIndex = rowOffset + rowIndex; return <tr key={`${absoluteIndex}-${dataset.columns.length}`}><td className="row-number-cell"><span>{absoluteIndex + 1}</span><button className="row-menu-trigger" onClick={() => setMenuRow(menuRow === absoluteIndex ? null : absoluteIndex)} aria-label={`Ações da linha ${absoluteIndex + 1}`}><MoreHorizontal size={15} /></button>{menuRow === absoluteIndex && <div className="row-menu"><button onClick={() => { onDuplicateRow(absoluteIndex); setMenuRow(null) }}><Copy size={13} />Duplicar linha</button><button className="danger-text" onClick={() => { onRemoveRow(absoluteIndex); setMenuRow(null) }}><Trash2 size={13} />Excluir linha</button></div>}</td>{dataset.columns.map((column) => <td key={column.id}><input aria-label={`${column.name}, linha ${absoluteIndex + 1}`} value={String(row[column.id] ?? '')} onChange={(event) => onCell(absoluteIndex, column.id, event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter') {
          const next = (event.target as HTMLInputElement).closest('tr')?.nextElementSibling?.querySelector('input')
          ;(next as HTMLInputElement | null)?.focus()
        }
      }} /></td>)}<td className="add-column-cell" /></tr> })}
        {!rows.length && <tr><td colSpan={dataset.columns.length + 2} className="table-empty">Ainda não há linhas. Use “Adicionar linha” ou cole células copiadas de uma planilha.</td></tr>}
      </tbody></table></div>
    <div className="table-add-row"><button onClick={onAddRow}><Plus size={14} />Adicionar outra linha</button><div className="table-pagination"><span>{dataset.rows.length ? `${rowOffset + 1}–${Math.min(rowOffset + pageSize, dataset.rows.length)} de ${dataset.rows.length}` : '0 linhas'}</span><button disabled={activePage === 0} onClick={() => setPage(Math.max(0, activePage - 1))} aria-label="Página anterior">‹</button><button disabled={rowOffset + pageSize >= dataset.rows.length} onClick={() => setPage(activePage + 1)} aria-label="Próxima página">›</button></div></div>
  </div>
}

interface ChartEditorProps {
  dataset: Dataset
  config: VisualizationConfig
  onChange: (patch: Partial<VisualizationConfig>) => void
  onAddFilter: () => void
  onUpdateFilter: (id: string, patch: Partial<DataFilter>) => void
}

function ChartEditor({ dataset, config, onChange, onAddFilter, onUpdateFilter }: ChartEditorProps) {
  const dimensions = dataset.columns.filter((column) => !isNumericType(column.type) || config.type === 'scatter')
  const metrics = dataset.columns.filter((column) => isNumericType(column.type))
  const seriesColumns = dataset.columns.filter((column) =>
    column.id !== config.dimensionId &&
    ['category', 'text', 'boolean'].includes(column.type) &&
    new Set(dataset.rows.map((row) => String(row[column.id] ?? ''))).size <= 20)
  const supportsSeries = ['bar', 'bar-horizontal', 'line', 'area'].includes(config.type)
  const showMetric = config.type !== 'scatter'
  const showAggregation = !['histogram', 'boxplot', 'summary'].includes(config.type)
  const showDimension = !['histogram', 'boxplot', 'summary'].includes(config.type)
  return <aside className="chart-editor">
    <div className="editor-header"><span className="editor-header-icon"><BarChart3 size={16} /></span><div><strong>Editar gráfico</strong><span>As mudanças aparecem na hora</span></div><button className="icon-button" title="Configurações atualizadas automaticamente" aria-label="Ajuda sobre edição"><CircleHelp size={15} /></button></div>
    <div className="editor-scroll">
      <div className="editor-field"><label htmlFor="chart-title">Título</label><input id="chart-title" value={config.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="Dê um título ao gráfico" /></div>
      <div className="editor-field"><label htmlFor="chart-subtitle">Descrição <span>opcional</span></label><input id="chart-subtitle" value={config.subtitle} onChange={(event) => onChange({ subtitle: event.target.value })} placeholder="Uma frase sobre esta visualização" /></div>
      <div className="editor-divider" />
      <div className="editor-section-heading"><span>VISUALIZAÇÃO</span></div>
      <div className="editor-field"><label htmlFor="chart-type">Tipo de gráfico</label><select id="chart-type" value={config.type} onChange={(event) => onChange({ type: event.target.value as VisualizationConfig['type'] })}>{['bar-horizontal', 'bar', 'line', 'area', 'pie', 'donut', 'histogram', 'boxplot', 'scatter', 'summary'].map((type) => <option key={type} value={type}>{chartName(type as VisualizationConfig['type'])}</option>)}</select></div>
      {showDimension && <div className="editor-field"><label htmlFor="dimension-select">{config.type === 'scatter' ? 'Medida horizontal' : 'Agrupar por'}</label><select id="dimension-select" value={config.dimensionId} onChange={(event) => onChange({ dimensionId: event.target.value, ...(event.target.value === config.seriesId ? { seriesId: undefined } : {}) })}><option value="">Cada linha</option>{dimensions.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></div>}
      {supportsSeries && seriesColumns.length > 0 && config.dimensionId && <div className="editor-field"><label htmlFor="series-select">Dividir em séries</label><select id="series-select" value={config.seriesId ?? ''} onChange={(event) => onChange({ seriesId: event.target.value || undefined })}><option value="">Não dividir</option>{seriesColumns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></div>}
      {config.type === 'scatter' && <div className="editor-field"><label htmlFor="scatter-y">Medida vertical</label><select id="scatter-y" value={config.metricId} onChange={(event) => onChange({ metricId: event.target.value })}>{metrics.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></div>}
      {showMetric && <div className="editor-field"><label htmlFor="metric-select">O que visualizar</label><select id="metric-select" value={config.metricId} onChange={(event) => onChange({ metricId: event.target.value, aggregation: event.target.value ? config.aggregation === 'count' ? 'sum' : config.aggregation : 'count' })}><option value="">Contagem de registros</option>{metrics.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></div>}
      {showMetric && showAggregation && <div className="editor-field"><label htmlFor="aggregation-select">Como calcular</label><select id="aggregation-select" value={config.metricId ? config.aggregation : 'count'} onChange={(event) => onChange({ aggregation: event.target.value as Aggregation })}>{Object.entries(aggregationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>}
      {showDimension && <div className="editor-field"><label htmlFor="chart-sort">Ordenação</label><select id="chart-sort" value={config.sort} onChange={(event) => onChange({ sort: event.target.value as VisualizationConfig['sort'] })}><option value="none">Ordem original</option><option value="ascending">Menor para maior</option><option value="descending">Maior para menor</option></select></div>}
      <div className="editor-divider" />
      <div className="editor-section-row"><div className="editor-section-heading"><span>FILTROS</span><span className="filter-count">{config.filters.length}</span></div><button className="filter-add" onClick={onAddFilter} disabled={!dataset.columns.length}><Plus size={13} />Adicionar filtro</button></div>
      {config.filters.map((filter) => {
        const column = dataset.columns.find((entry) => entry.id === filter.columnId)
        const isNumeric = column ? isNumericType(column.type) : false
        const operators = isNumeric ? numericOperators : ['equals', 'notEquals', 'contains', 'between'] as FilterOperator[]
        return <div className="filter-editor" key={filter.id}>
          <select aria-label="Coluna do filtro" value={filter.columnId} onChange={(event) => onUpdateFilter(filter.id, { columnId: event.target.value })}>{dataset.columns.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
          <select aria-label="Condição do filtro" value={filter.operator} onChange={(event) => onUpdateFilter(filter.id, { operator: event.target.value as FilterOperator })}>{operators.map((operator) => <option key={operator} value={operator}>{operatorLabels[operator]}</option>)}</select>
          <div className="filter-values"><input aria-label="Valor do filtro" type={dateInputType(column?.type) ? 'date' : 'text'} value={filter.value} placeholder="Valor" onChange={(event) => onUpdateFilter(filter.id, { value: event.target.value })} />{filter.operator === 'between' && <input aria-label="Valor final do filtro" type={dateInputType(column?.type) ? 'date' : 'number'} value={filter.valueTo ?? ''} placeholder="Até" onChange={(event) => onUpdateFilter(filter.id, { valueTo: event.target.value })} />}</div>
          <button className="filter-remove" aria-label="Remover filtro" onClick={() => onChange({ filters: config.filters.filter((item) => item.id !== filter.id) })}><X size={14} /></button>
        </div>
      })}
      {!config.filters.length && <button className="filter-empty" onClick={onAddFilter}><Filter size={14} />Filtre os dados do gráfico</button>}
      <div className="editor-divider" />
      <div className="editor-section-heading"><span>APARÊNCIA</span></div>
      <div className="appearance-row"><label htmlFor="chart-color">Cor principal</label><label className="color-picker" aria-label="Escolher cor do gráfico"><input id="chart-color" type="color" value={config.color} onChange={(event) => onChange({ color: event.target.value })} /><span>{config.color.toUpperCase()}</span></label></div>
      <label className="toggle-row"><span><strong>Rótulos de valores</strong><small>Mostrar valores sobre o gráfico</small></span><input type="checkbox" checked={config.showValues} onChange={(event) => onChange({ showValues: event.target.checked })} /><i /></label>
      <label className="toggle-row"><span><strong>Legenda</strong><small>Exibir categorias e séries</small></span><input type="checkbox" checked={config.showLegend} onChange={(event) => onChange({ showLegend: event.target.checked })} /><i /></label>
      <div className="editor-field"><label htmlFor="number-format">Formato dos valores</label><div className="format-row"><select id="number-format" value={config.numberFormat} onChange={(event) => onChange({ numberFormat: event.target.value as VisualizationConfig['numberFormat'] })}><option value="number">Número</option><option value="currency">Real (R$)</option><option value="percent">Porcentagem</option></select><select aria-label="Casas decimais" value={config.decimals} onChange={(event) => onChange({ decimals: Number(event.target.value) })}><option value={0}>0 casas</option><option value={1}>1 casa</option><option value={2}>2 casas</option><option value={3}>3 casas</option></select></div></div>
      <div className="editor-field"><label htmlFor="top-n">Limite de categorias</label><select id="top-n" value={config.topN} onChange={(event) => onChange({ topN: Number(event.target.value) })}><option value={10}>Top 10</option><option value={20}>Top 20</option><option value={50}>Top 50</option><option value={0}>Mostrar todas</option></select></div>
    </div>
  </aside>
}

function dateInputType(type?: ColumnType): boolean {
  return type === 'date' || type === 'datetime'
}

interface DashboardProps {
  dataset: Dataset
  charts: VisualizationConfig[]
  onOpen: (id: string) => void
  onRemove: (id: string) => void
  onResize: (id: string) => void
  onMove: (id: string, direction: number) => void
}

function Dashboard({ dataset, charts, onOpen, onRemove, onMove, onResize }: DashboardProps) {
  const numeric = dataset.columns.find((column) => isNumericType(column.type))
  const values = numeric ? dataset.rows.map((row) => parseNumber(row[numeric.id])) : []
  const stats = calculateStatistics(values)
  return <>
    {stats && <div className="dashboard-kpis">{[['Soma', stats.sum], ['Média', stats.average], ['Maior valor', stats.max], ['Registros', stats.count]].map(([label, value]) => <div className="dashboard-kpi" key={String(label)}><span>{label}</span><strong>{typeof value === 'number' ? formatNumber(value) : value}</strong><small>{numeric?.name ?? 'Todos os dados'}</small></div>)}</div>}
    {charts.length ? <div className="dashboard-grid">{charts.map((chart, index) => <article className={`dashboard-chart-card ${chart.size === 'wide' ? 'dashboard-wide' : ''}`} key={chart.id}>
      <div className="dashboard-chart-title"><div><strong>{chart.title || 'Visualização sem título'}</strong><span>{chartName(chart.type)} · {filteredRows(dataset, chart).length} linhas</span></div><div className="dashboard-card-actions"><button onClick={() => onMove(chart.id, -1)} disabled={index === 0} aria-label="Mover para cima">↑</button><button onClick={() => onMove(chart.id, 1)} disabled={index === charts.length - 1} aria-label="Mover para baixo">↓</button><button onClick={() => onResize(chart.id)} aria-label={chart.size === 'wide' ? 'Reduzir largura do cartão' : 'Ampliar largura do cartão'} title={chart.size === 'wide' ? 'Reduzir largura' : 'Ampliar largura'}>↔</button><button onClick={() => onOpen(chart.id)} aria-label="Editar visualização"><Search size={14} /></button><button onClick={() => onRemove(chart.id)} aria-label="Remover visualização"><X size={14} /></button></div></div>
      <button className="dashboard-chart-preview" onClick={() => onOpen(chart.id)}><Suspense fallback={<div className="chart-empty"><LoaderCircle className="spin" size={18} />Carregando…</div>}><ChartView dataset={dataset} config={chart} /></Suspense></button>
    </article>)}</div> : <div className="empty-dashboard"><div className="empty-illustration"><Grid2X2 size={28} /></div><h2>Seu painel está pronto para começar</h2><p>Crie visualizações a partir dos seus dados e adicione-as aqui para acompanhar tudo em um só lugar.</p><button className="button button-primary" onClick={() => onOpen('')}><Plus size={16} />Criar visualização</button></div>}
  </>
}

function ExportMenu({ onExport, onCsv }: { onExport: (format: 'svg' | 'png' | 'pdf') => void; onCsv: () => void }) {
  const [open, setOpen] = useState(false)
  return <div className="export-menu"><button className="button button-secondary button-small" onClick={() => setOpen(!open)} aria-expanded={open}><Download size={15} />Exportar<ChevronDown size={13} /></button>{open && <div className="export-popover" role="menu"><button role="menuitem" onClick={() => { onExport('png'); setOpen(false) }}>Imagem PNG</button><button role="menuitem" onClick={() => { onExport('svg'); setOpen(false) }}>Gráfico SVG</button><button role="menuitem" onClick={() => { onExport('pdf'); setOpen(false) }}>Salvar como PDF</button><div /><button role="menuitem" onClick={() => { onCsv(); setOpen(false) }}>Dados filtrados CSV</button></div>}</div>
}

function chartName(type: VisualizationConfig['type']): string {
  return chartNames[type]
}
