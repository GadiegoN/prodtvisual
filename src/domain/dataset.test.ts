import { describe, expect, it } from 'vitest'
import { analyzeDataset, detectColumnType, inferDataset, parseDateValue, parseNumber } from './dataset'
import { recommendVisualizations } from './recommendations'
import { calculateStatistics } from './statistics'
import { defaultVisualization, filteredRows, groupedData } from './visualization'

describe('dataset analysis', () => {
  it('detects numeric, category, date and boolean columns', () => {
    expect(detectColumnType(['1', '2', '3'])).toBe('integer')
    expect(detectColumnType(['1.5', '2.25'])).toBe('decimal')
    expect(detectColumnType(['1.234,00', '2.500,50'])).toBe('decimal')
    expect(detectColumnType(['1.000', '2.000'])).toBe('integer')
    expect(detectColumnType(['A', 'B', 'A'], 'Categoria')).toBe('category')
    expect(detectColumnType(['2026-01-01', '2026-02-01'])).toBe('date')
    expect(detectColumnType(['31/12/2026', '01/01/2027'])).toBe('date')
    expect(detectColumnType(['31/12/2026 09:30', '01/01/2027 11:45'])).toBe('datetime')
    expect(detectColumnType([new Date(2026, 0, 1), new Date(2026, 0, 2)])).toBe('date')
    expect(detectColumnType(['0', '1'])).toBe('integer')
    expect(detectColumnType(['sim', 'não'])).toBe('boolean')
  })

  it('parses Brazilian and international numeric formats', () => {
    expect(parseNumber('R$ 1.234,56')).toBe(1234.56)
    expect(parseNumber('1,234.56')).toBe(1234.56)
    expect(parseNumber('-42')).toBe(-42)
    expect(parseDateValue('31/12/2026')?.getMonth()).toBe(11)
  })

  it('profiles row, column, unique and missing-value counts', () => {
    const dataset = inferDataset([['Grupo', 'Valor'], ['A', '10'], ['B', ''], ['A', '30']])
    const profile = analyzeDataset(dataset)
    expect(profile.rowCount).toBe(3)
    expect(profile.columnCount).toBe(2)
    expect(profile.missingCells).toBe(1)
    expect(profile.columns[0].unique).toBe(2)
  })

  it('reports values that do not match an otherwise numeric column', () => {
    const dataset = inferDataset([['Valor'], ['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8'], ['9'], ['inválido']])
    const profile = analyzeDataset(dataset)
    expect(profile.columns[0].column.type).toBe('integer')
    expect(profile.columns[0].invalid).toBe(1)
    expect(profile.warnings).toContain('1 valor não corresponde ao tipo da coluna')
  })

  it('keeps headerless numeric tables as data and provides generic field names', () => {
    const dataset = inferDataset([['12', '3.5'], ['18', '4.5']])
    expect(dataset.columns.map((column) => column.name)).toEqual(['Coluna 1', 'Coluna 2'])
    expect(dataset.rows).toHaveLength(2)
  })

  it('recognizes headerless category and numeric tables without dropping the first record', () => {
    const dataset = inferDataset([['A', '10'], ['B', '20']])
    expect(dataset.columns.map((column) => column.name)).toEqual(['Coluna 1', 'Coluna 2'])
    expect(dataset.rows).toHaveLength(2)
  })
})

describe('statistics, recommendations and transformations', () => {
  it('calculates summary statistics using actual values', () => {
    expect(calculateStatistics(['1', '2', '9'])).toEqual({ count: 3, sum: 12, average: 4, median: 2, min: 1, max: 9 })
  })

  it('recommends an ordered chart for temporal data', () => {
    const dataset = inferDataset([['Data', 'Valor'], ['2026-01-01', '10'], ['2026-02-01', '20']])
    const suggestions = recommendVisualizations(dataset, analyzeDataset(dataset))
    expect(suggestions[0].type).toBe('line')
    expect(suggestions[0].score).toBeGreaterThan(0.9)
  })

  it('filters rows and groups them with aggregation', () => {
    const dataset = inferDataset([['Grupo', 'Valor'], ['A', '10'], ['B', '30'], ['A', '20']])
    const config = defaultVisualization(dataset)
    config.dimensionId = 'col_0'
    config.metricId = 'col_1'
    config.filters = [{ id: 'f1', columnId: 'col_0', operator: 'equals', value: 'A' }]
    const rows = filteredRows(dataset, config)
    expect(rows).toHaveLength(2)
    expect(groupedData(dataset, rows, config)).toEqual([{ name: 'A', value: 30 }])
  })

  it('includes the full final date when filtering a Brazilian date range', () => {
    const dataset = inferDataset([['Data', 'Valor'], ['31/12/2026', '10'], ['01/01/2027', '20'], ['02/01/2027', '30']])
    const config = defaultVisualization(dataset)
    config.filters = [{ id: 'range', columnId: 'col_0', operator: 'between', value: '2026-12-31', valueTo: '2027-01-01' }]
    expect(filteredRows(dataset, config)).toHaveLength(2)
  })

  it('compares numeric equality using locale-aware values', () => {
    const dataset = inferDataset([['Valor'], ['1.234,50']])
    const config = defaultVisualization(dataset)
    config.filters = [{ id: 'equal', columnId: 'col_0', operator: 'equals', value: '1234.5' }]
    expect(filteredRows(dataset, config)).toHaveLength(1)
  })

  it('groups multiple measures into readable chart series', () => {
    const dataset = inferDataset([
      ['Período', 'Canal', 'Valor'],
      ['Jan', 'Online', '10'],
      ['Jan', 'Loja', '5'],
      ['Fev', 'Online', '20'],
      ['Fev', 'Loja', '7'],
    ])
    const config = defaultVisualization(dataset, 'line', 'col_0', 'col_2')
    config.seriesId = 'col_1'
    const grouped = groupedData(dataset, dataset.rows, config)
    expect(grouped[0].seriesLabels).toEqual({ s0: 'Online', s1: 'Loja' })
    expect(grouped[0].seriesValues).toEqual({ s0: 10, s1: 5 })
    expect(grouped[1].value).toBe(27)
  })
})
