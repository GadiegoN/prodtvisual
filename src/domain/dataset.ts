export type ColumnType = 'text' | 'category' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'unknown'
export type CellValue = string | number | boolean | null

export interface DatasetColumn {
  id: string
  name: string
  type: ColumnType
}

export interface Dataset {
  columns: DatasetColumn[]
  rows: Record<string, CellValue>[]
}

export interface ColumnProfile {
  column: DatasetColumn
  missing: number
  unique: number
  invalid: number
  values: number[]
  mean?: number
  median?: number
  min?: number
  max?: number
}

export interface DatasetProfile {
  rowCount: number
  columnCount: number
  columns: ColumnProfile[]
  missingCells: number
  warnings: string[]
}

const DATE_LIKE = /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/
const DATETIME_LIKE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  let normalized = value.trim().replace(/[R$€£\s]/g, '').replace(/%$/, '')
  if (!normalized) return null
  const comma = normalized.lastIndexOf(',')
  const dot = normalized.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    normalized = comma > dot
      ? normalized.replace(/\./g, '').replace(',', '.')
      : normalized.replace(/,/g, '')
  } else if (comma >= 0) {
    const decimals = normalized.length - comma - 1
    normalized = decimals > 0 && decimals <= 2
      ? normalized.replace(/\./g, '').replace(',', '.')
      : normalized.replace(/,/g, '')
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '')
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string') return null
  const brazilian = value.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (brazilian) {
    const [, day, month, rawYear, hour = '0', minute = '0', second = '0'] = brazilian
    const year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear)
    const date = new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
    if (date.getFullYear() !== year || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null
    return date
  }
  const isoDate = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoDate) {
    const [, year, month, day] = isoDate
    const date = new Date(Number(year), Number(month) - 1, Number(day))
    if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null
    return date
  }
  if (!DATETIME_LIKE.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isDate(value: string): boolean {
  return (DATE_LIKE.test(value) || DATETIME_LIKE.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) && parseDateValue(value) !== null
}

function hasDecimalNotation(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isInteger(value)
  if (typeof value !== 'string') return false
  const normalized = value.trim().replace(/[R$€£\s%]/g, '')
  const comma = normalized.lastIndexOf(',')
  const dot = normalized.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) return (comma > dot ? normalized.length - comma : normalized.length - dot) > 1
  if (comma >= 0) {
    const places = normalized.length - comma - 1
    return places > 0 && places <= 2
  }
  if (dot >= 0 && !/^-?\d{1,3}(\.\d{3})+$/.test(normalized)) return true
  return false
}

export function detectColumnType(values: unknown[], name = ''): ColumnType {
  const present = values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
  if (!present.length) return 'unknown'
  const strings = present.map(String)
  const normalizedName = name.toLocaleLowerCase()
  const booleanValues = new Set(strings.map((v) => v.trim().toLocaleLowerCase()))
  if ([...booleanValues].every((v) => ['true', 'false', 'sim', 'não', 'nao', 'yes', 'no'].includes(v))) {
    return 'boolean'
  }
  const dateRate = present.filter((value) => value instanceof Date || isDate(String(value))).length / present.length
  if (dateRate >= 0.8) return present.some((value) =>
    value instanceof Date ? value.getHours() + value.getMinutes() + value.getSeconds() > 0 :
      DATETIME_LIKE.test(String(value)) || /\d{1,2}:\d{2}/.test(String(value))) ? 'datetime' : 'date'
  const numericRate = present.filter((value) => parseNumber(value) !== null).length / present.length
  if (numericRate >= 0.8) {
    const parsed = present.map(parseNumber).filter((value): value is number => value !== null)
    return present.some(hasDecimalNotation) || !parsed.every(Number.isInteger) ? 'decimal' : 'integer'
  }
  const distinct = new Set(strings.map((value) => value.trim().toLocaleLowerCase())).size
  const categoryLimit = Math.max(20, Math.ceil(strings.length * 0.35))
  const categoryName = /categoria|tipo|grupo|regi[aã]o|estado|cidade|status|produto|nome|class|segment|country|name/.test(normalizedName)
  return categoryName || (distinct <= categoryLimit && distinct <= 50) ? 'category' : 'text'
}

export function inferDataset(input: unknown[][]): Dataset {
  if (!input.length) return { columns: [], rows: [] }
  const firstRowIsData = input[0].length > 0 && input[0].every((value) =>
    parseNumber(value) !== null || parseDateValue(value) !== null || typeof value === 'boolean' ||
    (typeof value === 'string' && /^(true|false|sim|não|nao|yes|no)$/i.test(value.trim()))) ||
    input[0].some((_, index) => {
      const firstType = detectColumnType([input[0][index]])
      const remaining = input.slice(1).map((row) => row[index]).filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
      const otherType = detectColumnType(remaining)
      return firstType === otherType && (isNumericType(firstType) || firstType === 'date' || firstType === 'datetime')
    }) && input[0].every((_, index) => {
      const firstType = detectColumnType([input[0][index]])
      const remaining = input.slice(1).map((row) => row[index]).filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
      const otherType = detectColumnType(remaining)
      return firstType !== 'unknown' && firstType === otherType
    })
  const table = firstRowIsData ? [input[0].map((_, index) => `Coluna ${index + 1}`), ...input] : input
  const width = table.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const sourceHeaders = table[0].map((value, index) => String(value ?? '').trim() || `Coluna ${index + 1}`)
  const headers = Array.from({ length: width }, (_, index) => sourceHeaders[index] || `Coluna ${index + 1}`)
  const counts = new Map<string, number>()
  const columns = headers.map((name, index) => {
    const base = name
    const count = (counts.get(base.toLocaleLowerCase()) ?? 0) + 1
    counts.set(base.toLocaleLowerCase(), count)
    const uniqueName = count > 1 ? `${base} ${count}` : base
    const id = `col_${index}`
    const values = table.slice(1).map((row) => row[index] ?? null)
    return { id, name: uniqueName, type: detectColumnType(values, uniqueName) }
  })
  const rows = table.slice(1)
    .filter((row) => row.some((value) => value !== null && value !== undefined && String(value).trim() !== ''))
    .map((row) => Object.fromEntries(columns.map((column, index) => [column.id, normalizeCell(row[index] ?? null)])))
  return { columns, rows }
}

function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean' || typeof value === 'number') return value
  return String(value).trim()
}

export function analyzeDataset(dataset: Dataset): DatasetProfile {
  const columns = dataset.columns.map((column): ColumnProfile => {
    const values = dataset.rows.map((row) => row[column.id])
    const populated = values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
    const numericValues = populated.map(parseNumber).filter((value): value is number => value !== null)
    const invalid = isNumericType(column.type)
      ? populated.length - numericValues.length
      : ['date', 'datetime'].includes(column.type)
        ? populated.filter((value) => parseDateValue(value) === null).length
        : column.type === 'boolean'
          ? populated.filter((value) => !['true', 'false', 'sim', 'não', 'nao', 'yes', 'no'].includes(String(value).trim().toLocaleLowerCase())).length
          : 0
    const sorted = [...numericValues].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return {
      column,
      missing: values.length - populated.length,
      unique: new Set(populated.map((value) => String(value))).size,
      invalid,
      values: numericValues,
      ...(numericValues.length ? {
        mean: numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length,
        median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        min: sorted[0],
        max: sorted[sorted.length - 1],
      } : {}),
    }
  })
  const missingCells = columns.reduce((sum, column) => sum + column.missing, 0)
  const invalidCells = columns.reduce((sum, column) => sum + column.invalid, 0)
  const warnings: string[] = []
  if (missingCells) warnings.push(`${missingCells} célula${missingCells === 1 ? '' : 's'} sem valor`)
  if (invalidCells) warnings.push(`${invalidCells} valor${invalidCells === 1 ? '' : 'es'} não corresponde${invalidCells === 1 ? '' : 'm'} ao tipo da coluna`)
  if (!dataset.rows.length) warnings.push('A tabela ainda não contém linhas com dados')
  if (columns.some((column) => column.column.type === 'unknown')) warnings.push('Algumas colunas não têm valores suficientes para identificar o tipo')
  if (columns.some((column) => column.unique === 1 && dataset.rows.length > 1)) warnings.push('Há colunas com apenas um valor distinto')
  return { rowCount: dataset.rows.length, columnCount: dataset.columns.length, columns, missingCells, warnings }
}

export function isNumericType(type: ColumnType): boolean {
  return type === 'integer' || type === 'decimal'
}
