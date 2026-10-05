import { isNumericType, parseDateValue, parseNumber } from './dataset'
import type { CellValue, Dataset, DatasetColumn } from './dataset'
import type { ChartType } from './recommendations'

export type Aggregation = 'sum' | 'average' | 'count' | 'min' | 'max'
export type FilterOperator = 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains' | 'between'
export interface DataFilter {
  id: string
  columnId: string
  operator: FilterOperator
  value: string
  valueTo?: string
}
export interface VisualizationConfig {
  id: string
  type: ChartType
  title: string
  subtitle: string
  dimensionId: string
  metricId: string
  aggregation: Aggregation
  sort: 'none' | 'ascending' | 'descending'
  topN: number
  color: string
  showLegend: boolean
  showValues: boolean
  decimals: number
  numberFormat: 'number' | 'currency' | 'percent'
  filters: DataFilter[]
  size?: 'normal' | 'wide'
  seriesId?: string
}

export interface GroupedDatum {
  name: string
  value: number
  seriesValues?: Record<string, number>
  seriesLabels?: Record<string, string>
}

export function defaultVisualization(dataset: Dataset, type: ChartType = 'bar-horizontal', dimensionId?: string, metricId?: string): VisualizationConfig {
  const dimension = dataset.columns.find((column) => column.id === dimensionId)
    ?? dataset.columns.find((column) => !isNumericType(column.type))
    ?? dataset.columns[0]
  const metric = dataset.columns.find((column) => column.id === metricId)
    ?? dataset.columns.find((column) => isNumericType(column.type))
  return {
    id: crypto.randomUUID(),
    type,
    title: dimension && metric ? `${metric.name} por ${dimension.name}` : (metric?.name ?? 'Visão geral'),
    subtitle: '',
    dimensionId: dimension?.id ?? '',
    metricId: metric?.id ?? '',
    aggregation: metric ? 'sum' : 'count',
    sort: type === 'bar-horizontal' ? 'descending' : 'none',
    topN: 20,
    color: '#6258e8',
    showLegend: true,
    showValues: false,
    decimals: 2,
    numberFormat: 'number',
    filters: [],
  }
}

export function filteredRows(dataset: Dataset, config: VisualizationConfig): Record<string, CellValue>[] {
  return dataset.rows.filter((row) => config.filters.every((filter) => {
    const value = row[filter.columnId]
    const target = filter.value
    if (value === null || value === undefined) return false
    const actualNumber = parseNumber(value)
    const targetNumber = parseNumber(target)
    const actualDate = parseDateValue(value)?.getTime()
    const targetDate = parseDateValue(target)?.getTime()
    const equality = actualDate !== undefined && targetDate !== undefined
      ? actualDate === targetDate
      : actualNumber !== null && targetNumber !== null
        ? actualNumber === targetNumber
        : String(value).toLocaleLowerCase() === target.toLocaleLowerCase()
    switch (filter.operator) {
      case 'equals': return equality
      case 'notEquals': return !equality
      case 'contains': return String(value).toLocaleLowerCase().includes(target.toLocaleLowerCase())
      case 'greaterThan': return actualNumber !== null && targetNumber !== null && actualNumber > targetNumber
      case 'lessThan': return actualNumber !== null && targetNumber !== null && actualNumber < targetNumber
      case 'between': {
        const end = parseNumber(filter.valueTo)
        if (actualNumber !== null && targetNumber !== null && end !== null) return actualNumber >= targetNumber && actualNumber <= end
        const time = parseDateValue(value)?.getTime()
        const from = parseDateValue(target)?.getTime()
        const parsedTo = parseDateValue(filter.valueTo)
        if (parsedTo && !/\d{1,2}:\d{2}/.test(filter.valueTo ?? '')) parsedTo.setHours(23, 59, 59, 999)
        const to = parsedTo?.getTime()
        return time !== undefined && from !== undefined && to !== undefined && time >= from && time <= to
      }
    }
  }))
}

function metricValue(rows: Record<string, CellValue>[], column: DatasetColumn | undefined, aggregation: Aggregation): number {
  if (aggregation === 'count' || !column) return rows.length
  const values = rows.map((row) => parseNumber(row[column.id])).filter((value): value is number => value !== null)
  if (!values.length) return 0
  switch (aggregation) {
    case 'sum': return values.reduce((sum, value) => sum + value, 0)
    case 'average': return values.reduce((sum, value) => sum + value, 0) / values.length
    case 'min': return values.reduce((minimum, value) => Math.min(minimum, value), Infinity)
    case 'max': return values.reduce((maximum, value) => Math.max(maximum, value), -Infinity)
  }
}

export function groupedData(dataset: Dataset, rows: Record<string, CellValue>[], config: VisualizationConfig): GroupedDatum[] {
  const dimension = dataset.columns.find((column) => column.id === config.dimensionId)
  const metric = dataset.columns.find((column) => column.id === config.metricId)
  if (!dimension) {
    return rows.map((row, index) => ({ name: String(index + 1), value: metricValue([row], metric, config.aggregation) }))
  }
  const groups = new Map<string, Record<string, CellValue>[]>()
  rows.forEach((row) => {
    const value = row[dimension.id]
    const key = value === null || value === undefined || value === '' ? '(sem valor)' : String(value)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  })
  const seriesColumn = dataset.columns.find((column) => column.id === config.seriesId)
  if (seriesColumn) {
    const weights = new Map<string, number>()
    rows.forEach((row) => {
      const name = String(row[seriesColumn.id] ?? '(sem valor)')
      weights.set(name, (weights.get(name) ?? 0) + metricValue([row], metric, config.aggregation))
    })
    const seriesLabels: Record<string, string> = {}
    const seriesKeys = new Map<string, string>()
    ;[...weights].sort((a, b) => b[1] - a[1]).forEach(([name], index, sorted) => {
      if (index < 8) {
        const key = `s${index}`
        seriesKeys.set(name, key)
        seriesLabels[key] = name
      } else if (sorted.length > 8) {
        seriesKeys.set(name, 'other')
        seriesLabels.other = 'Outras séries'
      }
    })
    let result: GroupedDatum[] = [...groups].map(([name, group]) => {
      const seriesGroups = new Map<string, Record<string, CellValue>[]>()
      group.forEach((row) => {
        const label = String(row[seriesColumn.id] ?? '(sem valor)')
        const key = seriesKeys.get(label) ?? 'other'
        const seriesGroup = seriesGroups.get(key)
        if (seriesGroup) seriesGroup.push(row)
        else seriesGroups.set(key, [row])
      })
      const seriesValues = Object.fromEntries(Object.entries(seriesLabels).map(([key]) => [
        key,
        metricValue(seriesGroups.get(key) ?? [], metric, config.aggregation),
      ]))
      return {
        name,
        value: Object.values(seriesValues).reduce((sum, value) => sum + value, 0),
        seriesValues,
        seriesLabels,
      }
    })
    const temporal = ['date', 'datetime'].includes(dimension.type)
    if (temporal) result.sort((a, b) => (parseDateValue(a.name)?.getTime() ?? 0) - (parseDateValue(b.name)?.getTime() ?? 0))
    else if (config.sort !== 'none') result.sort((a, b) => config.sort === 'ascending' ? a.value - b.value : b.value - a.value)
    if (config.topN > 0 && result.length > config.topN && !temporal) result = result.slice(0, config.topN)
    return result
  }
  let result = [...groups].map(([name, group]) => ({ name, value: metricValue(group, metric, config.aggregation) }))
  const temporal = ['date', 'datetime'].includes(dimension.type)
  if (temporal) result.sort((a, b) => (parseDateValue(a.name)?.getTime() ?? 0) - (parseDateValue(b.name)?.getTime() ?? 0))
  else if (config.sort !== 'none') result.sort((a, b) => config.sort === 'ascending' ? a.value - b.value : b.value - a.value)
  if (config.topN > 0 && result.length > config.topN && !temporal) result = result.slice(0, config.topN)
  return result
}

export function histogram(values: number[], bucketCount = 10): { name: string; value: number; start: number; end: number }[] {
  if (!values.length) return []
  const min = values.reduce((minimum, value) => Math.min(minimum, value), Infinity)
  const max = values.reduce((maximum, value) => Math.max(maximum, value), -Infinity)
  const width = max === min ? 1 : (max - min) / bucketCount
  const bins = Array.from({ length: bucketCount }, (_, index) => ({
    name: `${formatTick(min + width * index)}–${formatTick(index === bucketCount - 1 ? max : min + width * (index + 1))}`,
    value: 0,
    start: min + width * index,
    end: min + width * (index + 1),
  }))
  values.forEach((value) => {
    const index = Math.min(bucketCount - 1, Math.floor((value - min) / width))
    bins[index].value += 1
  })
  return bins
}

export function formatTick(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value)
}
