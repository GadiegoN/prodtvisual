import { describe, expect, it } from 'vitest'
import { inferDataset } from '../domain/dataset'
import { exportCsv } from './csvExport'

describe('CSV export', () => {
  it('quotes cells and neutralizes spreadsheet formula values', () => {
    const dataset = inferDataset([['Nome', 'Observação'], ['Ana', '=1+1'], ['Bia', '-texto'], ['Caio', '-12']])
    const csv = exportCsv(dataset, dataset.rows)
    expect(csv).toContain('"\'=1+1"')
    expect(csv).toContain('"\'-texto"')
    expect(csv).toContain('"-12"')
  })
})
