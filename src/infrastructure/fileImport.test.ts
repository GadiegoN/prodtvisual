import { describe, expect, it } from 'vitest'
import { parseCsv } from './fileImport'

describe('CSV import', () => {
  it('detects Brazilian semicolon delimiters and decimal commas', () => {
    expect(parseCsv('Nome;Valor\r\nA;1.234,56\r\nB;20,5')).toEqual([
      ['Nome', 'Valor'],
      ['A', '1.234,56'],
      ['B', '20,5'],
    ])
  })

  it('keeps quoted separators and line breaks inside fields', () => {
    expect(parseCsv('Nome,Observação\r\n"Ana","uma, nota\nem duas linhas"\r\n')).toEqual([
      ['Nome', 'Observação'],
      ['Ana', 'uma, nota\nem duas linhas'],
    ])
  })

  it('reports malformed unclosed quoted fields', () => {
    expect(() => parseCsv('nome,observação\nAna,"sem fim')).toThrow(/aspas/)
  })
})
