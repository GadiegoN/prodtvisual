import { isNumericType } from './dataset'
import type { Dataset, DatasetProfile } from './dataset'

export type ChartType = 'bar' | 'bar-horizontal' | 'line' | 'area' | 'pie' | 'donut' | 'histogram' | 'boxplot' | 'scatter' | 'summary'
export interface Recommendation {
  type: ChartType
  title: string
  description: string
  score: number
  dimensionId?: string
  metricId?: string
}

const labels: Record<ChartType, string> = {
  bar: 'Barras', 'bar-horizontal': 'Barras horizontais', line: 'Linha', area: 'Área',
  pie: 'Pizza', donut: 'Donut', histogram: 'Histograma', boxplot: 'Box plot',
  scatter: 'Dispersão', summary: 'Resumo estatístico',
}

export function recommendVisualizations(dataset: Dataset, profile: DatasetProfile): Recommendation[] {
  const dimensions = profile.columns.filter((item) => ['category', 'text', 'boolean', 'date', 'datetime'].includes(item.column.type) && item.unique > 1)
  const numeric = profile.columns.filter((item) => isNumericType(item.column.type))
  const temporal = dimensions.find((item) => ['date', 'datetime'].includes(item.column.type))
  const category = dimensions.find((item) => !['date', 'datetime'].includes(item.column.type) && item.unique <= 60)
  const suggestions: Recommendation[] = []
  const add = (type: ChartType, score: number, description: string, dimensionId?: string, metricId?: string) => {
    suggestions.push({ type, title: labels[type], description, score, dimensionId, metricId })
  }
  if (temporal && numeric.length) {
    add('line', 0.98, `Mostra a evolução de ${numeric[0].column.name} ao longo do tempo.`, temporal.column.id, numeric[0].column.id)
    add('area', 0.87, 'Destaca a tendência e o volume acumulado no período.', temporal.column.id, numeric[0].column.id)
    add('bar', 0.72, 'Compara os valores entre períodos.', temporal.column.id, numeric[0].column.id)
  } else if (category && numeric.length) {
    add('bar-horizontal', 0.95, `Compara ${numeric[0].column.name} por ${category.column.name}.`, category.column.id, numeric[0].column.id)
    add('bar', 0.89, 'Facilita comparar os valores de cada grupo.', category.column.id, numeric[0].column.id)
    if (category.unique >= 2 && category.unique <= 6 && numeric[0].values.every((value) => value >= 0)) {
      add('donut', 0.68, 'Mostra a participação de cada grupo no total.', category.column.id, numeric[0].column.id)
    }
  } else if (numeric.length >= 2) {
    add('scatter', 0.9, 'Revela relações entre duas medidas numéricas.', numeric[0].column.id, numeric[1].column.id)
  } else if (category) {
    add('bar-horizontal', 0.88, `Conta registros em cada valor de ${category.column.name}.`, category.column.id)
    if (category.unique <= 6) add('donut', 0.62, 'Mostra a participação de cada valor no total.', category.column.id)
  }
  if (numeric.length) {
    add('histogram', category ? 0.62 : 0.92, `Explora a distribuição de ${numeric[0].column.name}.`, undefined, numeric[0].column.id)
    add('boxplot', 0.55, 'Resume a distribuição e ajuda a localizar valores extremos.', undefined, numeric[0].column.id)
    add('summary', 0.6, 'Veja média, mediana, mínimo, máximo e total.', undefined, numeric[0].column.id)
  } else if (dataset.columns.length === 1 && dataset.rows.length) {
    add('bar', 0.7, 'Conta quantas vezes cada valor aparece.', dataset.columns[0].id)
  }
  return suggestions.sort((a, b) => b.score - a.score).slice(0, 5)
}
