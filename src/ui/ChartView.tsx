import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts'
import { parseDateValue, parseNumber } from '../domain/dataset'
import type { Dataset } from '../domain/dataset'
import { calculateStatistics, percentage } from '../domain/statistics'
import { filteredRows, groupedData, histogram } from '../domain/visualization'
import type { VisualizationConfig } from '../domain/visualization'

interface Props {
  dataset: Dataset
  config: VisualizationConfig
}

const palette = ['#6258e8', '#28a47b', '#e5a343', '#df6d6d', '#4588d2', '#a16bc0', '#43a6ad', '#dc8b50']

export function ChartView({ dataset, config }: Props) {
  const darkTheme = document.documentElement.dataset.theme === 'dark'
  const chartTextColor = darkTheme ? '#aeb4c4' : '#8a8fa1'
  const chartGridColor = darkTheme ? '#303544' : '#eceef3'
  const rows = filteredRows(dataset, config)
  const metric = dataset.columns.find((column) => column.id === config.metricId)
  const numericValues = rows.map((row) => parseNumber(metric ? row[metric.id] : null)).filter((value): value is number => value !== null)
  const stats = calculateStatistics(numericValues)
  const grouped = groupedData(dataset, rows, config)
  const series = Object.entries(grouped[0]?.seriesLabels ?? {})
  const formatValue = (value: number) => {
    if (config.numberFormat === 'currency') {
      return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: config.decimals }).format(value)
    }
    if (config.numberFormat === 'percent') return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: config.decimals }).format(value)}%`
    return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: config.decimals }).format(value)
  }
  const sharedTooltip = {
    contentStyle: {
      border: `1px solid ${darkTheme ? '#34394a' : '#e8eaf0'}`,
      borderRadius: 10,
      boxShadow: '0 8px 24px #080a121f',
      backgroundColor: darkTheme ? '#1b1e28' : '#fff',
      color: darkTheme ? '#edf0f7' : '#27293a',
    },
    formatter: (value: number, name: string) => [formatValue(Number(value)), name],
  }

  if (!rows.length) {
    return <div className="chart-empty"><span className="empty-chart-mark">↗</span><strong>Nenhum dado para mostrar</strong><span>Revise os filtros deste gráfico.</span></div>
  }
  if (config.type === 'summary') {
    return stats ? <div className="chart-stat-grid">
      {[
        ['Total', formatValue(stats.sum)],
        ['Média', formatValue(stats.average)],
        ['Mediana', formatValue(stats.median)],
        ['Maior valor', formatValue(stats.max)],
        ['Menor valor', formatValue(stats.min)],
        ['Registros', new Intl.NumberFormat('pt-BR').format(stats.count)],
      ].map(([label, value]) => <div className="chart-stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div> : <div className="chart-empty">Selecione uma coluna numérica para ver o resumo.</div>
  }
  if (config.type === 'histogram') {
    const data = histogram(numericValues, Math.min(12, Math.max(5, Math.round(Math.sqrt(numericValues.length)))))
    return data.length ? <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 18, right: 12, bottom: 8, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
        <XAxis dataKey="name" tick={{ fill: chartTextColor, fontSize: 11 }} angle={-24} textAnchor="end" height={48} axisLine={false} tickLine={false} />
        <YAxis allowDecimals={false} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip formatter={(value: number) => [new Intl.NumberFormat('pt-BR').format(Number(value)), 'Frequência']} contentStyle={sharedTooltip.contentStyle} />
        <Bar dataKey="value" name="Frequência" fill={config.color} radius={[5, 5, 0, 0]} />
      </BarChart>
    </ResponsiveContainer> : <div className="chart-empty">Este gráfico precisa de uma coluna numérica.</div>
  }
  if (config.type === 'boxplot') {
    if (!stats) return <div className="chart-empty">Este gráfico precisa de uma coluna numérica.</div>
    const sorted = [...numericValues].sort((a, b) => a - b)
    const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]
    const q1 = quantile(0.25)
    const q3 = quantile(0.75)
    const min = Math.min(...sorted)
    const max = Math.max(...sorted)
    const range = max - min || 1
    const x = (value: number) => 32 + ((value - min) / range) * 88
    return <div className="boxplot-wrap" role="img" aria-label={`Distribuição: mínimo ${formatValue(min)}, mediana ${formatValue(stats.median)}, máximo ${formatValue(max)}`}>
      <div className="boxplot-title">{metric?.name ?? 'Distribuição dos valores'}</div>
      <svg viewBox="0 0 160 80" preserveAspectRatio="none">
        <line x1={x(min)} y1="39" x2={x(max)} y2="39" stroke={config.color} strokeWidth="2" />
        <line x1={x(min)} y1="29" x2={x(min)} y2="49" stroke={config.color} strokeWidth="2" />
        <line x1={x(max)} y1="29" x2={x(max)} y2="49" stroke={config.color} strokeWidth="2" />
        <rect x={x(q1)} y="20" width={Math.max(2, x(q3) - x(q1))} height="38" rx="4" fill={`${config.color}25`} stroke={config.color} strokeWidth="2" />
        <line x1={x(stats.median)} y1="20" x2={x(stats.median)} y2="58" stroke={config.color} strokeWidth="3" />
      </svg>
      <div className="boxplot-labels"><span>Mín. {formatValue(min)}</span><span>Mediana {formatValue(stats.median)}</span><span>Máx. {formatValue(max)}</span></div>
    </div>
  }
  if (config.type === 'scatter') {
    const xColumn = dataset.columns.find((column) => column.id === config.dimensionId)
    const points = rows.map((row) => ({
      x: parseNumber(xColumn ? row[xColumn.id] : null),
      y: parseNumber(metric ? row[metric.id] : null),
      label: xColumn ? String(row[xColumn.id] ?? '') : '',
    })).filter((point): point is { x: number; y: number; label: string } => point.x !== null && point.y !== null)
    return points.length ? <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 18, right: 18, bottom: 10, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
        <XAxis type="number" dataKey="x" name={xColumn?.name} tickFormatter={formatValue} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis type="number" dataKey="y" name={metric?.name} tickFormatter={formatValue} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} />
        <Scatter data={points} fill={config.color} fillOpacity={0.75} />
        {config.showLegend && <Legend />}
      </ScatterChart>
    </ResponsiveContainer> : <div className="chart-empty">Escolha duas colunas numéricas com valores válidos para relacionar.</div>
  }
  if (config.type === 'pie' || config.type === 'donut') {
    if (grouped.some((item) => item.value < 0)) return <div className="chart-empty"><strong>Proporções precisam de valores não negativos</strong><span>Escolha barras ou um resumo para manter os valores negativos.</span></div>
    if (grouped.length < 2 || grouped.length > 8) return <div className="chart-empty">A proporção funciona melhor com 2 a 8 categorias. Escolha barras para mais categorias.</div>
    const total = grouped.reduce((sum, item) => sum + Math.max(item.value, 0), 0)
    return <div className="pie-layout">
      <div className="pie-chart"><ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={grouped} dataKey="value" nameKey="name" innerRadius={config.type === 'donut' ? '58%' : 0} outerRadius="84%" paddingAngle={2} stroke="none" label={config.showValues ? (entry) => `${Math.round(percentage(entry.value, total))}%` : false}>
            {grouped.map((item, index) => <Cell key={item.name} fill={palette[index % palette.length]} />)}
          </Pie>
          <Tooltip formatter={(value: number) => formatValue(Number(value))} />
        </PieChart>
      </ResponsiveContainer></div>
      {config.showLegend && <div className="pie-legend">{grouped.map((item, index) => <div className="pie-legend-item" key={item.name}><i style={{ backgroundColor: palette[index % palette.length] }} /><span>{item.name}</span><strong>{total ? `${Math.round(percentage(item.value, total))}%` : '0%'}</strong></div>)}</div>}
    </div>
  }
  const isHorizontal = config.type === 'bar-horizontal'
  const valueAxis = <YAxis dataKey="name" type={isHorizontal ? 'category' : 'number'} width={isHorizontal ? 110 : 48} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} />
  const chartMargin = { top: 12, right: 16, bottom: 8, left: 4 }
  const baseProps = { data: grouped, margin: chartMargin, layout: isHorizontal ? 'vertical' as const : 'horizontal' as const }
  const categorical = dataset.columns.find((column) => column.id === config.dimensionId)
  const dateAxis = categorical && ['date', 'datetime'].includes(categorical.type)
    ? (value: string) => {
      const date = parseDateValue(value)
      return !date ? value : new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' }).format(date)
    }
    : undefined
  if (config.type === 'line') return <ResponsiveContainer width="100%" height="100%">
    <LineChart {...baseProps}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
      {isHorizontal ? <>{valueAxis}<XAxis type="number" tickFormatter={formatValue} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} /></> : <><XAxis dataKey="name" tickFormatter={dateAxis} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} /><YAxis tickFormatter={formatValue} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} /></>}
      <Tooltip {...sharedTooltip} />
      {config.showLegend && <Legend />}
      {series.length ? series.map(([key, name], index) => <Line key={key} name={name} type="monotone" dataKey={`seriesValues.${key}`} stroke={palette[index % palette.length]} strokeWidth={2.5} dot={{ r: grouped.length > 30 ? 0 : 3 }} activeDot={{ r: 5 }} label={config.showValues ? { position: 'top', fontSize: 9, formatter: (value: number) => formatValue(value) } : false} />) :
        <Line name={metric?.name ?? 'Registros'} type="monotone" dataKey="value" stroke={config.color} strokeWidth={3} dot={{ r: grouped.length > 30 ? 0 : 3 }} activeDot={{ r: 5 }} label={config.showValues ? { position: 'top', fontSize: 9, formatter: (value: number) => formatValue(value) } : false} />}
    </LineChart>
  </ResponsiveContainer>
  if (config.type === 'area') return <ResponsiveContainer width="100%" height="100%">
    <AreaChart {...baseProps}>
      <defs><linearGradient id={`fill-${config.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={config.color} stopOpacity={0.24} /><stop offset="95%" stopColor={config.color} stopOpacity={0.01} /></linearGradient></defs>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
      <XAxis dataKey="name" tickFormatter={dateAxis} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} />
      <YAxis tickFormatter={formatValue} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} />
      <Tooltip {...sharedTooltip} />
      {config.showLegend && <Legend />}
      {series.length ? series.map(([key, name], index) => <Area key={key} name={name} type="monotone" dataKey={`seriesValues.${key}`} stroke={palette[index % palette.length]} strokeWidth={2} fill={palette[index % palette.length]} fillOpacity={0.12} />) :
        <Area name={metric?.name ?? 'Registros'} type="monotone" dataKey="value" stroke={config.color} strokeWidth={2.5} fill={`url(#fill-${config.id})`} />}
    </AreaChart>
  </ResponsiveContainer>
  const barChartType = config.type === 'bar' || config.type === 'bar-horizontal'
  if (barChartType) return <ResponsiveContainer width="100%" height="100%">
    <BarChart {...baseProps}>
      <CartesianGrid strokeDasharray="3 3" vertical={isHorizontal} horizontal={!isHorizontal} stroke={chartGridColor} />
      {isHorizontal ? <>{valueAxis}<XAxis type="number" tickFormatter={formatValue} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} /></> : <><XAxis dataKey="name" tickFormatter={dateAxis} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} /><YAxis tickFormatter={formatValue} tick={{ fill: chartTextColor, fontSize: 11 }} axisLine={false} tickLine={false} /></>}
      <Tooltip {...sharedTooltip} />
      {config.showLegend && <Legend />}
      {series.length ? series.map(([key, name], index) => <Bar key={key} name={name} dataKey={`seriesValues.${key}`} fill={palette[index % palette.length]} radius={isHorizontal ? [0, 5, 5, 0] : [5, 5, 0, 0]} maxBarSize={42} label={config.showValues ? { position: isHorizontal ? 'right' : 'top', fill: '#6c7182', fontSize: 9, formatter: (value: number) => formatValue(value) } : false} />) :
        <Bar name={metric?.name ?? 'Registros'} dataKey="value" fill={config.color} radius={isHorizontal ? [0, 5, 5, 0] : [5, 5, 0, 0]} maxBarSize={42} label={config.showValues ? { position: isHorizontal ? 'right' : 'top', fill: '#6c7182', fontSize: 10, formatter: (value: number) => formatValue(value) } : false} />}
    </BarChart>
  </ResponsiveContainer>
  return <div className="chart-empty">Não há colunas adequadas para este tipo de visualização.</div>
}
