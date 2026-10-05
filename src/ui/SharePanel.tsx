import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { FormEvent } from 'react'
import { apiRequest } from '../infrastructure/saasApi'

interface ShareLink {
  id: string
  access: 'PUBLIC' | 'LINK_ONLY'
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

interface SharePanelProps {
  projectId: string
  organizationId: string
  open: boolean
  onClose: () => void
}

export function SharePanel({ projectId, organizationId, open, onClose }: SharePanelProps) {
  const [links, setLinks] = useState<ShareLink[]>([])
  const [access, setAccess] = useState<'LINK_ONLY' | 'PUBLIC'>('LINK_ONLY')
  const [expiresInDays, setExpiresInDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [createdUrl, setCreatedUrl] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    const result = await apiRequest<{ shares: ShareLink[] }>(`/api/projects/${encodeURIComponent(projectId)}/shares`, {}, organizationId)
    setLinks(result.shares)
  }, [organizationId, projectId])

  useEffect(() => {
    if (!open) return
    setError('')
    void reload().catch((cause) => setError(cause instanceof Error ? cause.message : 'Não foi possível carregar os links.'))
  }, [open, projectId, organizationId])

  if (!open) return null

  async function createLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const body: { access: 'LINK_ONLY' | 'PUBLIC'; expiresInDays?: number } = { access }
      if (expiresInDays) body.expiresInDays = Number(expiresInDays)
      const result = await apiRequest<{ share: { url: string } }>(`/api/projects/${encodeURIComponent(projectId)}/shares`, {
        method: 'POST',
        body: JSON.stringify(body),
      }, organizationId)
      setCreatedUrl(result.share.url)
      await reload()
      try {
        await navigator.clipboard.writeText(result.share.url)
        setNotice('Link criado e copiado. Qualquer pessoa com este link poderá visualizar o projeto.')
      } catch {
        setError('O link foi criado, mas não foi possível copiá-lo automaticamente. Copie-o no campo abaixo.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar ou copiar o link.')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(link: ShareLink): Promise<void> {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(link.id)}`, {
        method: 'DELETE',
      }, organizationId)
      await reload()
      setNotice('Link revogado.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível revogar o link.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="account-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="account-panel share-panel" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <header className="account-panel-heading">
        <div><div className="eyebrow">ACESSO AO PROJETO</div><h2 id="share-title">Compartilhar</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
      </header>
      {(error || notice) && <div className={`account-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}
      <p className="share-description">Os links usam um token aleatório armazenado como hash. Revogue um link a qualquer momento para bloquear novos acessos.</p>
      <form className="share-create-form" onSubmit={createLink}>
        <label>Tipo de acesso<select value={access} onChange={(event) => setAccess(event.target.value as 'LINK_ONLY' | 'PUBLIC')}><option value="LINK_ONLY">Somente quem tem o link</option><option value="PUBLIC">Público</option></select></label>
        <label>Expira em<select value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)}><option value="">Nunca</option><option value="1">1 dia</option><option value="7">7 dias</option><option value="30">30 dias</option><option value="365">1 ano</option></select></label>
        <button className="button button-primary" disabled={busy}>{busy ? 'Aguarde…' : 'Criar link e copiar'}</button>
      </form>
      {createdUrl && <label className="share-url-field">Link criado<input readOnly value={createdUrl} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="button button-secondary button-small" onClick={() => void navigator.clipboard.writeText(createdUrl).then(() => setNotice('Link copiado.')).catch(() => setError('Não foi possível copiar o link.'))}>Copiar</button></label>}
      <div className="share-links">
        <strong>Links criados</strong>
        {!links.length && <span>Nenhum link foi criado para este projeto.</span>}
        {links.map((link) => <div className="share-link-row" key={link.id}>
          <div><strong>{link.access === 'PUBLIC' ? 'Público' : 'Com link'}</strong><span>{link.revokedAt ? 'Revogado' : link.expiresAt ? `Expira ${new Date(link.expiresAt).toLocaleString('pt-BR')}` : 'Sem expiração'}</span></div>
          {!link.revokedAt && <button className="text-button danger-text" disabled={busy} onClick={() => void revoke(link)}>Revogar</button>}
        </div>)}
      </div>
    </section>
  </div>
}
