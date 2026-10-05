import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { FormEvent } from 'react'
import type { Project } from '../infrastructure/projects'
import {
  apiRequest, signIn, signOut, signUp,
} from '../infrastructure/saasApi'
import type { AccountUser, AuthSession, Organization } from '../infrastructure/saasApi'

interface AccountPanelProps {
  open: boolean
  session: AuthSession | null
  activeOrganizationId: string
  resetToken: string | null
  invitationToken: string | null
  localProjects: Project[]
  cloudMode: boolean
  onClose: () => void
  onAuthenticated: () => Promise<void>
  onSignedOut: () => Promise<void>
  onSelectOrganization: (organizationId: string) => Promise<void>
  onCloudModeChange: (enabled: boolean) => Promise<void>
  onMigrate: (projectIds: string[]) => Promise<number>
}

interface Member {
  id: string
  email: string
  name: string
  role: Organization['role']
}

interface Invitation {
  id: string
  email: string
  role: string
  expiresAt: string
}

interface UsageItem {
  usage: number
  limit: number
}

interface OrganizationUsage {
  planId: string
  usage: {
    projects: UsageItem
    datasets: UsageItem
    members: UsageItem
    rows: UsageItem
    storage: UsageItem
    exportsThisMonth: UsageItem
  }
}

type AuthMode = 'login' | 'register' | 'forgot' | 'reset'

export function AccountPanel({
  open, session, activeOrganizationId, resetToken, invitationToken, localProjects, cloudMode, onClose,
  onAuthenticated, onSignedOut, onSelectOrganization, onCloudModeChange, onMigrate,
}: AccountPanelProps) {
  const [authMode, setAuthMode] = useState<AuthMode>(resetToken ? 'reset' : 'login')
  const [name, setName] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'MEMBER' | 'VIEWER'>('MEMBER')
  const [newOrganizationName, setNewOrganizationName] = useState('')
  const [selectedProjects, setSelectedProjects] = useState<string[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [usage, setUsage] = useState<OrganizationUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [billingPlan, setBillingPlan] = useState<'PRO' | 'BUSINESS'>('PRO')

  const organization = useMemo(
    () => session?.organizations.find((item) => item.id === activeOrganizationId) ?? session?.organizations[0],
    [activeOrganizationId, session],
  )

  useEffect(() => {
    if (!open || !organization || !session?.user?.emailVerified) return
    let cancelled = false
    const load = async () => {
      setError('')
      try {
        const [memberResult, invitationResult, usageResult] = await Promise.all([
          apiRequest<{ members: Member[] }>('/api/organizations/current/members', {}, organization.id),
          organization.role === 'OWNER' || organization.role === 'ADMIN'
            ? apiRequest<{ invitations: Invitation[] }>('/api/organizations/current/invitations', {}, organization.id)
            : Promise.resolve({ invitations: [] }),
          apiRequest<OrganizationUsage>('/api/usage', {}, organization.id),
        ])
        if (cancelled) return
        setMembers(memberResult.members)
        setInvitations(invitationResult.invitations)
        setUsage(usageResult)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar os dados da organização.')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [open, organization, session?.user?.emailVerified])

  useEffect(() => {
    if (resetToken) setAuthMode('reset')
  }, [resetToken])

  if (!open) return null

  async function run(operation: () => Promise<void>, success?: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
      if (success) setNotice(success)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a operação.')
    } finally {
      setBusy(false)
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (authMode === 'reset') {
      if (!resetToken) { setError('O link de recuperação está inválido ou expirou.'); return }
      if (password !== confirmPassword) { setError('As senhas digitadas não são iguais.'); return }
      await run(async () => {
        await apiRequest('/api/auth/reset-password', {
          method: 'POST', body: JSON.stringify({ token: resetToken, password }),
        })
        setPassword('')
        setConfirmPassword('')
        setAuthMode('login')
        history.replaceState(null, '', '/')
        setNotice('Senha alterada. Entre com a nova senha.')
      })
      return
    }
    if (authMode === 'forgot') {
      await run(async () => {
        const result = await apiRequest<{ message: string }>('/api/auth/forgot-password', {
          method: 'POST', body: JSON.stringify({ email }),
        })
        setNotice(result.message)
      })
      return
    }
    if (authMode === 'register') {
      if (password !== confirmPassword) { setError('As senhas digitadas não são iguais.'); return }
      await run(async () => {
        const result = await signUp({ name, email, password, organizationName })
        setNotice(result.message)
      })
      return
    }
    await run(async () => {
      await signIn(email, password)
      await onAuthenticated()
      setPassword('')
      setNotice('Acesso realizado.')
    })
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run(async () => {
      const result = await apiRequest<{ organization: Organization }>('/api/organizations', {
        method: 'POST', body: JSON.stringify({ name: newOrganizationName }),
      })
      setNewOrganizationName('')
      await onSelectOrganization(result.organization.id)
    }, 'Organização criada.')
  }

  async function resendVerification(): Promise<void> {
    await run(async () => {
      const result = await apiRequest<{ message: string }>('/api/auth/resend-verification', {
        method: 'POST', body: JSON.stringify({ email }),
      })
      setNotice(result.message)
    })
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!organization) return
    await run(async () => {
      await apiRequest('/api/organizations/current/invitations', {
        method: 'POST', body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      }, organization.id)
      setInviteEmail('')
      const result = await apiRequest<{ invitations: Invitation[] }>('/api/organizations/current/invitations', {}, organization.id)
      setInvitations(result.invitations)
    }, 'Convite enviado.')
  }

  async function changeMember(member: Member, action: 'remove' | 'OWNER' | 'VIEWER' | 'MEMBER' | 'ADMIN') {
    if (!organization) return
    await run(async () => {
      if (action === 'remove') {
        await apiRequest(`/api/organizations/current/members/${member.id}`, { method: 'DELETE' }, organization.id)
      } else {
        await apiRequest(`/api/organizations/current/members/${member.id}`, {
          method: 'PATCH', body: JSON.stringify({ role: action }),
        }, organization.id)
      }
      await onSelectOrganization(organization.id)
      const result = await apiRequest<{ members: Member[] }>('/api/organizations/current/members', {}, organization.id)
      setMembers(result.members)
    })
  }

  async function createCheckout() {
    if (!organization) return
    await run(async () => {
      const result = await apiRequest<{ url: string }>('/api/billing/checkout', {
        method: 'POST', body: JSON.stringify({ plan: billingPlan }),
      }, organization.id)
      window.location.assign(result.url)
    })
  }

  async function openBillingPortal() {
    if (!organization) return
    await run(async () => {
      const result = await apiRequest<{ url: string }>('/api/billing/portal', { method: 'POST' }, organization.id)
      window.location.assign(result.url)
    })
  }

  const user: AccountUser | null = session?.user ?? null
  const canManageMembers = organization?.role === 'OWNER' || organization?.role === 'ADMIN'
  const owner = organization?.role === 'OWNER'

  return <div className="account-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="account-panel" role="dialog" aria-modal="true" aria-labelledby="account-title">
      <header className="account-panel-heading">
        <div><div className="eyebrow">{user ? 'CONTA E ORGANIZAÇÃO' : 'VISTA SAAS'}</div><h2 id="account-title">{user ? 'Sua conta' : 'Acesse seu espaço'}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
      </header>
      {(error || notice) && <div className={`account-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}
      {!user ? <form className="account-auth-form" onSubmit={submitAuth}>
        {authMode !== 'forgot' && authMode !== 'reset' && <div className="account-mode-tabs"><button type="button" className={authMode === 'login' ? 'active' : ''} onClick={() => { setAuthMode('login'); setError(''); setNotice('') }}>Entrar</button><button type="button" className={authMode === 'register' ? 'active' : ''} onClick={() => { setAuthMode('register'); setError(''); setNotice('') }}>Criar conta</button></div>}
        <p>{authMode === 'register' ? 'Crie sua conta para salvar visualizações em uma organização e acessá-las em outros dispositivos.' : authMode === 'forgot' ? 'Informe o e-mail da conta. Se ela existir, enviaremos instruções de recuperação.' : authMode === 'reset' ? 'Defina uma nova senha para sua conta.' : 'Entre para acessar as organizações e projetos salvos na nuvem.'}</p>
        {authMode === 'register' && <>
          <label>Seu nome<input autoComplete="name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Nome da organização<input required maxLength={120} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} /></label>
        </>}
        <label>E-mail<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        {authMode !== 'forgot' && <label>Senha<input type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
        {(authMode === 'reset' || authMode === 'register') && <label>Confirme a senha<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}
        <button className="button button-primary account-submit" disabled={busy}>{busy ? 'Aguarde…' : authMode === 'register' ? 'Criar conta' : authMode === 'forgot' ? 'Enviar instruções' : authMode === 'reset' ? 'Alterar senha' : 'Entrar'}</button>
        {authMode === 'login' && <button type="button" className="account-link" onClick={() => { setAuthMode('forgot'); setError(''); setNotice('') }}>Esqueci minha senha</button>}
        {(authMode === 'login' || authMode === 'register') && <button type="button" className="account-link" disabled={busy || !email} onClick={() => void resendVerification()}>Reenviar verificação de e-mail</button>}
        {authMode === 'forgot' && <button type="button" className="account-link" onClick={() => { setAuthMode('login'); setError(''); setNotice('') }}>Voltar para entrar</button>}
        <div className="account-local-note">Seus projetos locais continuam neste navegador. A migração para a nuvem é sempre explícita.</div>
      </form> : <div className="account-content">
        <div className="account-user"><div className="profile-avatar">{user.name.slice(0, 1).toLocaleUpperCase()}</div><div><strong>{user.name}</strong><span>{user.email}{user.emailVerified ? ' · e-mail verificado' : ' · verificação pendente'}</span></div><button className="text-button" disabled={busy} onClick={() => run(async () => { await signOut(); await onSignedOut() })}>Sair</button></div>
        {!user.emailVerified && <div className="account-warning">Verifique seu e-mail para criar organizações e acessar dados na nuvem. Use o link enviado após o cadastro.<button className="account-link" disabled={busy} onClick={() => {
          setEmail(user.email)
          void run(async () => {
            const result = await apiRequest<{ message: string }>('/api/auth/resend-verification', {
              method: 'POST', body: JSON.stringify({ email: user.email }),
            })
            setNotice(result.message)
          })
        }}>Reenviar e-mail de verificação</button></div>}
        {invitationToken && <section className="account-section"><strong>Convite para uma organização</strong><span>Confirme que deseja participar com a conta {user.email}.</span><button className="button button-primary button-small" disabled={busy || !user.emailVerified} onClick={() => run(async () => {
          const result = await apiRequest<{ organizationId: string }>('/api/auth/invitations/accept', {
            method: 'POST', body: JSON.stringify({ token: invitationToken }),
          })
          await onSelectOrganization(result.organizationId)
          history.replaceState(null, '', '/')
          setNotice('Convite aceito. A organização foi adicionada à sua conta.')
        })}>Aceitar convite</button></section>}
        <details className="account-section">
          <summary>Alterar senha</summary>
          <form className="account-auth-form" onSubmit={(event) => {
            event.preventDefault()
            if (password !== confirmPassword) { setError('As senhas digitadas não são iguais.'); return }
            void run(async () => {
              await apiRequest('/api/auth/change-password', {
                method: 'POST', body: JSON.stringify({ currentPassword, password }),
              })
              setCurrentPassword('')
              setPassword('')
              setConfirmPassword('')
            }, 'Senha alterada. As outras sessões foram encerradas.')
          }}>
            <label>Senha atual<input type="password" autoComplete="current-password" minLength={1} maxLength={128} required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
            <label>Nova senha<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label>Confirme a nova senha<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
            <button className="button button-secondary button-small" disabled={busy}>Alterar senha</button>
          </form>
        </details>
        {session!.organizations.length > 0 ? <>
          <section className="account-section">
            <div className="account-section-heading"><div><strong>Organização</strong><span>Projetos e membros são isolados por workspace.</span></div><span className="account-role">{organization?.role}</span></div>
            <select aria-label="Organização atual" value={organization?.id ?? ''} disabled={busy} onChange={(event) => run(() => onSelectOrganization(event.target.value))}>
              {session!.organizations.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.planId}</option>)}
            </select>
            {organization && <div className="account-usage">
              <UsageLine label="Projetos" item={usage?.usage.projects} />
              <UsageLine label="Datasets" item={usage?.usage.datasets} />
              <UsageLine label="Membros" item={usage?.usage.members} />
              <UsageLine label="Exports este mês" item={usage?.usage.exportsThisMonth} />
            </div>}
            <form className="account-inline-form" onSubmit={createOrganization}>
              <input aria-label="Nome da nova organização" required maxLength={120} placeholder="Nome da nova organização" value={newOrganizationName} onChange={(event) => setNewOrganizationName(event.target.value)} />
              <button className="button button-secondary button-small" disabled={busy || !user.emailVerified}>Criar</button>
            </form>
          </section>
          <section className="account-section">
            <div className="account-section-heading"><div><strong>Armazenamento</strong><span>{cloudMode ? 'Novos salvamentos vão para a organização atual.' : 'Seus projetos permanecem neste navegador.'}</span></div></div>
            <label className="account-toggle"><input type="checkbox" checked={cloudMode} disabled={busy || !user.emailVerified || !organization} onChange={(event) => run(() => onCloudModeChange(event.target.checked))} /><span>Salvar novos projetos na nuvem</span></label>
            {localProjects.length > 0 && <div className="migration-box">
              <strong>Projetos locais neste navegador</strong>
              <span>{localProjects.length} projeto(s) encontrados. Escolha quais copiar para a organização atual; os originais locais serão mantidos.</span>
              <div className="migration-list">{localProjects.map((item) => <label key={item.id}><input type="checkbox" checked={selectedProjects.includes(item.id)} onChange={(event) => setSelectedProjects((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><span>{item.name}<small>{item.dataset.rows.length} linhas · {item.dataset.columns.length} colunas</small></span></label>)}</div>
              <button className="button button-secondary button-small" disabled={busy || !user.emailVerified || !organization || !selectedProjects.length} onClick={() => run(async () => {
                const imported = await onMigrate(selectedProjects)
                setSelectedProjects([])
                setNotice(`${imported} projeto(s) copiado(s) para a nuvem. Os projetos locais foram preservados.`)
              })}>Importar selecionados</button>
            </div>}
          </section>
          <section className="account-section">
            <div className="account-section-heading"><div><strong>Plano e cobrança</strong><span>Plano atual: {organization?.planId ?? 'FREE'} · limites validados no servidor.</span></div></div>
            {owner && <div className="account-inline-form">
              <select aria-label="Plano para contratação" value={billingPlan} onChange={(event) => setBillingPlan(event.target.value as 'PRO' | 'BUSINESS')}><option value="PRO">Pro</option><option value="BUSINESS">Business</option></select>
              <button className="button button-primary button-small" disabled={busy} onClick={() => void createCheckout()}>Assinar plano</button>
              <button className="button button-secondary button-small" disabled={busy} onClick={() => void openBillingPortal()}>Gerenciar</button>
            </div>}
          </section>
          <section className="account-section">
            <div className="account-section-heading"><div><strong>Membros</strong><span>Permissões aplicadas no servidor.</span></div></div>
            <div className="account-members">{members.map((member) => <div className="account-member" key={member.id}>
              <div><strong>{member.name}</strong><span>{member.email}</span></div>
              {canManageMembers && member.role !== 'OWNER' && member.id !== user.id && (owner || member.role !== 'ADMIN')
                ? <div className="member-actions"><select aria-label={`Permissão de ${member.email}`} value={member.role} disabled={busy} onChange={(event) => void changeMember(member, event.target.value as 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER')}>{owner && <option value="OWNER">Proprietário</option>}<option value="ADMIN">Admin</option><option value="MEMBER">Membro</option><option value="VIEWER">Visualizador</option></select><button className="text-button danger-text" disabled={busy} onClick={() => void changeMember(member, 'remove')}>Remover</button></div>
                : <span className="account-role">{member.role}</span>}
            </div>)}</div>
            {canManageMembers && <form className="account-inline-form invite-form" onSubmit={inviteMember}>
              <input type="email" required maxLength={254} placeholder="E-mail do novo membro" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
              <select aria-label="Permissão do convite" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'ADMIN' | 'MEMBER' | 'VIEWER')}><option value="MEMBER">Membro</option><option value="VIEWER">Visualizador</option><option value="ADMIN">Admin</option></select>
              <button className="button button-secondary button-small" disabled={busy}>Convidar</button>
            </form>}
            {invitations.length > 0 && <div className="account-invitations"><strong>Convites pendentes</strong>{invitations.map((invitation) => <div key={invitation.id}><span>{invitation.email} · {invitation.role}</span><button className="text-button danger-text" disabled={busy} onClick={() => run(async () => {
              await apiRequest(`/api/organizations/current/invitations/${invitation.id}`, { method: 'DELETE' }, organization!.id)
              setInvitations((current) => current.filter((item) => item.id !== invitation.id))
            })}>Revogar</button></div>)}</div>}
          </section>
        </> : <section className="account-section"><strong>Esta conta ainda não tem uma organização.</strong><form className="account-inline-form" onSubmit={createOrganization}><input required maxLength={120} placeholder="Nome da organização" value={newOrganizationName} onChange={(event) => setNewOrganizationName(event.target.value)} /><button className="button button-primary button-small" disabled={busy || !user.emailVerified}>Criar organização</button></form></section>}
      </div>}
    </section>
  </div>
}

function UsageLine({ label, item }: { label: string; item?: UsageItem }) {
  if (!item) return <div><span>{label}</span><strong>Carregando…</strong></div>
  return <div><span>{label}</span><strong>{item.usage.toLocaleString('pt-BR')} / {item.limit < 0 ? 'Ilimitado' : item.limit.toLocaleString('pt-BR')}</strong></div>
}
