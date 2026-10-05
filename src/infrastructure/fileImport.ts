import { inferDataset } from '../domain/dataset'
import type { Dataset } from '../domain/dataset'
import type { WorkBook } from '@e965/xlsx'

const MAX_FILE_SIZE = 20 * 1024 * 1024

export async function importFile(file: File): Promise<Dataset> {
  if (file.size > MAX_FILE_SIZE) throw new Error('O arquivo excede o limite de 20 MB.')
  const extension = file.name.split('.').pop()?.toLocaleLowerCase()
  if (!['csv', 'json', 'xlsx', 'xls'].includes(extension ?? '')) {
    throw new Error('Formato não suportado. Escolha um arquivo CSV, JSON ou Excel.')
  }
  let dataset: Dataset
  if (extension === 'json') {
    const text = await file.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('Não foi possível ler o JSON. Verifique a sintaxe do arquivo.')
    }
    const records = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null ? [parsed] : []
    if (!records.length || records.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))) {
      throw new Error('O JSON deve conter uma lista de objetos com a mesma estrutura.')
    }
    const keys = [...new Set(records.flatMap((item) => Object.keys(item as Record<string, unknown>)))]
    dataset = inferDataset([keys, ...records.map((item) => keys.map((key) => (item as Record<string, unknown>)[key] ?? null))])
  } else if (extension === 'csv') {
    dataset = inferDataset(parseCsv(await file.text()))
  } else {
    const XLSX = await import('@e965/xlsx')
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
    dataset = sheetToDataset(workbook, XLSX)
  }
  if (!dataset.columns.length) throw new Error('Não encontramos uma tabela com cabeçalhos nesse arquivo.')
  if (!dataset.rows.length) throw new Error('O arquivo não contém linhas de dados.')
  return dataset
}

export function parseCsv(text: string): unknown[][] {
  text = text.replace(/^\uFEFF/, '')
  const candidates = [',', ';', '\t']
  let delimiter = ','
  let maximumCount = 0
  for (const candidate of candidates) {
    let count = 0
    let quoted = false
    for (const char of text.split(/\r?\n/, 1)[0]) {
      if (char === '"') quoted = !quoted
      else if (char === candidate && !quoted) count += 1
    }
    if (count > maximumCount) {
      maximumCount = count
      delimiter = candidate
    }
  }
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"' && quoted && text[index + 1] === '"') {
      field += '"'
      index += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === delimiter && !quoted) {
      row.push(field.trim())
      field = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field.trim())
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  row.push(field.trim())
  if (row.some((value) => value !== '')) rows.push(row)
  if (quoted) throw new Error('O CSV contém um campo entre aspas que não foi fechado.')
  return rows
}

function sheetToDataset(workbook: WorkBook, xlsx: typeof import('@e965/xlsx')): Dataset {
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return { columns: [], rows: [] }
  const sheet = workbook.Sheets[sheetName]
  const table = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true })
  return inferDataset(table)
}
