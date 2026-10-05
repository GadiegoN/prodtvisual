import { describe, expect, it } from 'vitest'
import * as XLSX from '@e965/xlsx'
import { importFile } from './fileImport'

describe('file import formats', () => {
  it('loads and profiles a CSV file', async () => {
    const file = new File(['Grupo;Valor\nA;1,5\nB;2,5'], 'dataset.csv', { type: 'text/csv' })
    const dataset = await importFile(file)
    expect(dataset.rows).toHaveLength(2)
    expect(dataset.columns[1].type).toBe('decimal')
    expect(dataset.rows[0][dataset.columns[1].id]).toBe('1,5')
  })

  it('imports arrays of records from JSON', async () => {
    const file = new File(['[{"grupo":"A","valor":4},{"grupo":"B","valor":7}]'], 'dataset.json', { type: 'application/json' })
    const dataset = await importFile(file)
    expect(dataset.columns.map((column) => column.name)).toEqual(['grupo', 'valor'])
    expect(dataset.rows).toHaveLength(2)
  })

  it('imports the first worksheet from XLSX files', async () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['Categoria', 'Valor'], ['A', 12], ['B', 24]])
    XLSX.utils.book_append_sheet(workbook, sheet, 'Dados')
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
    const file = new File([new Uint8Array(bytes)], 'dataset.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const dataset = await importFile(file)
    expect(dataset.rows).toHaveLength(2)
    expect(dataset.columns[1].type).toBe('integer')
  })
})
