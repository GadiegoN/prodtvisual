import { createHmac, randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import { config } from './config'
import { query, ServiceUnavailableError, transaction } from './db'
import { SaaSError, authorizeRole, type OrganizationRole } from '../src/domain/saas'

export interface AuthenticatedUser {
  id: string
  email: string
  name: string
  emailVerified: boolean
}

export interface AuthenticatedOrganization {
  id: string
  name: string
  slug: string
  role: OrganizationRole
  planId: 'FREE' | 'PRO' | 'BUSINESS'
  status: 'free' | 'incomplete' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid'
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser | null
    organization: AuthenticatedOrganization | null
  }
}

export function digest(value: string): Buffer {
  if (!config.AUTH_SECRET || config.AUTH_SECRET.length < 32) {
    throw new Error('AUTH_SECRET must contain at least 32 characters before authentication can be used.')
  }
  return createHmac('sha256', config.AUTH_SECRET).update(value).digest()
}

export function secureToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashPassword(password: string): Promise<string> {
  return import('bcryptjs').then(({ hash }) => hash(password, 12))
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return import('bcryptjs').then(({ compare }) => compare(password, passwordHash))
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie('vista_session', token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 14,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie('vista_session', { path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax' })
}

export async function requireUser(request: FastifyRequest): Promise<AuthenticatedUser> {
  if (!config.authEnabled) throw new ServiceUnavailableError('SaaS authentication is not configured. Set DATABASE_URL and a 32-character AUTH_SECRET.')
  const token = request.cookies.vista_session
  if (!token) throw new SaaSError('Authentication is required.', 'FORBIDDEN')
  const result = await query<AuthenticatedUser & { email_verified_at: Date | null }>(
    `SELECT u.id, u.email, u.name, u.email_verified_at
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [digest(token)],
  )
  const user = result.rows[0]
  if (!user) throw new SaaSError('Your session has expired. Please sign in again.', 'FORBIDDEN')
  request.user = { id: user.id, email: user.email, name: user.name, emailVerified: Boolean(user.email_verified_at) }
  return request.user
}

export async function requireOrganization(request: FastifyRequest, permission?: string): Promise<AuthenticatedOrganization> {
  const user = request.user ?? await requireUser(request)
  if (!user.emailVerified) throw new SaaSError('Confirm your email address before accessing organization data.', 'FORBIDDEN')
  const organizationId = request.headers['x-organization-id']
  if (typeof organizationId !== 'string') throw new SaaSError('Select an organization before continuing.', 'FORBIDDEN')
  const result = await query<AuthenticatedOrganization>(
    `SELECT o.id, o.name, o.slug, m.role, s.plan_id AS "planId", s.status
     FROM memberships m
     JOIN organizations o ON o.id = m.organization_id
     JOIN subscriptions s ON s.organization_id = o.id
     WHERE m.user_id = $1 AND o.id = $2`,
    [user.id, organizationId],
  )
  const organization = result.rows[0]
  if (!organization) throw new SaaSError('You do not belong to this organization.', 'FORBIDDEN')
  if (permission) authorizeRole(organization.role, permission)
  request.organization = organization
  return organization
}

export async function recordAudit(
  client: PoolClient,
  orgId: string,
  userId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [orgId, userId, action, resourceType, resourceId, JSON.stringify(metadata)],
  )
}

export async function createSession(userId: string): Promise<string> {
  const token = secureToken()
  await query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '14 days')`,
    [digest(token), userId],
  )
  return token
}

export async function consumeToken<T>(token: string, purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD', action: (client: PoolClient, userId: string) => Promise<T>): Promise<T | null> {
  return transaction(async (client) => {
    const result = await client.query<{ user_id: string }>(
      `SELECT user_id FROM email_tokens
       WHERE token_hash = $1 AND purpose = $2 AND expires_at > now()
       FOR UPDATE`,
      [digest(token), purpose],
    )
    const userId = result.rows[0]?.user_id
    if (!userId) return null
    const value = await action(client, userId)
    await client.query('DELETE FROM email_tokens WHERE token_hash = $1', [digest(token)])
    return value
  })
}
