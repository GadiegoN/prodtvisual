import type { CellValue, Dataset } from '../domain/dataset'

export function exportCsv(dataset: Dataset, rows: Record<string, CellValue>[]): string {
  const quote = (value: unknown) => {
    const text = String(value ?? '')
    const formulaLike = /^[\t\r ]*[=+@]/.test(text) || /^[\t\r ]*-(?!\d)/.test(text)
    return `"${`${formulaLike ? "'" : ''}${text}`.replace(/"/g, '""')}"`
  }
  return `\uFEFF${[
    dataset.columns.map((column) => quote(column.name)).join(';'),
    ...rows.map((row) => dataset.columns.map((column) => quote(row[column.id])).join(';')),
  ].join('\r\n')}`
}
