import type { Project } from './projects'

export interface Organization {
  id: string
  name: string
  slug: string
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'
  planId: 'FREE' | 'PRO' | 'BUSINESS'
  status: string
}

export interface AccountUser {
  id: string
  email: string
  name: string
  emailVerified: boolean
}

export interface AuthSession {
  user: AccountUser | null
  organizations: Organization[]
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  organizationId?: string,
): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  if (organizationId) headers.set('x-organization-id', organizationId)
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'include',
  })
  if (response.status === 204) return undefined as T
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const data = payload && typeof payload === 'object'
      ? payload as { error?: unknown; message?: unknown; code?: unknown }
      : {}
    throw new ApiError(
      typeof data.error === 'string' ? data.error
        : typeof data.message === 'string' ? data.message
          : `Request failed (${response.status}).`,
      response.status,
      typeof data.code === 'string' ? data.code : undefined,
    )
  }
  return payload as T
}

export function fetchAuthSession(): Promise<AuthSession> {
  return apiRequest<AuthSession>('/api/auth/me')
}

export function signIn(email: string, password: string): Promise<{ user: AccountUser }> {
  return apiRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
}

export function signUp(input: { email: string; name: string; password: string; organizationName: string }): Promise<{ verificationRequired: boolean; message: string }> {
  return apiRequest('/api/auth/register', { method: 'POST', body: JSON.stringify(input) })
}

export function signOut(): Promise<void> {
  return apiRequest('/api/auth/logout', { method: 'POST' })
}

export function fetchOrganizationProjects(organizationId: string): Promise<{ projects: Project[] }> {
  return apiRequest('/api/projects', {}, organizationId)
}

export function createOrganizationProject(project: Project, organizationId: string): Promise<{ project: Project }> {
  return apiRequest('/api/projects', { method: 'POST', body: JSON.stringify(project) }, organizationId)
}

export function updateOrganizationProject(project: Project, organizationId: string): Promise<{ project: Project }> {
  return apiRequest(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', body: JSON.stringify(project) }, organizationId)
}

export function deleteOrganizationProject(projectId: string, organizationId: string): Promise<void> {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }, organizationId)
}

export function trackOrganizationExport(format: 'csv' | 'png' | 'svg' | 'pdf', organizationId: string): Promise<void> {
  return apiRequest('/api/usage/exports', { method: 'POST', body: JSON.stringify({ format }) }, organizationId)
}

export function fetchSharedProject(token: string): Promise<{ project: Project; access: 'PUBLIC' | 'LINK_ONLY' }> {
  return apiRequest(`/api/shares/${encodeURIComponent(token)}`)
}
