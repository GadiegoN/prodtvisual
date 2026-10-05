export type Locale = 'pt-BR' | 'en-US'
const copy = {
  'pt-BR': {
    create: 'Criar visualização', projects: 'Meus projetos', dashboard: 'Painel', data: 'Dados',
    createNew: 'Nova visualização', save: 'Salvar projeto', saved: 'Projeto salvo',
    import: 'Importar arquivo', sample: 'Experimentar com dados de exemplo', addRow: 'Adicionar linha',
    addColumn: 'Adicionar coluna', chart: 'Adicionar ao painel', export: 'Exportar', language: 'Idioma',
  },
  'en-US': {
    create: 'Create visualization', projects: 'My projects', dashboard: 'Dashboard', data: 'Data',
    createNew: 'New visualization', save: 'Save project', saved: 'Project saved',
    import: 'Import file', sample: 'Try with sample data', addRow: 'Add row',
    addColumn: 'Add column', chart: 'Add to dashboard', export: 'Export', language: 'Language',
  },
} satisfies Record<Locale, Record<string, string>>

export function translate(locale: Locale, key: keyof typeof copy['pt-BR']): string {
  return copy[locale][key]
}
