import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { query, transaction } from './db'
import { sendPasswordRecovery, sendVerification } from './email'
import { effectivePlanId, hasEntitlement, PLAN_CATALOG } from '../src/domain/saas'
import { config } from './config'
import {
  clearSessionCookie, consumeToken, createSession, digest, hashPassword, requireUser,
  secureToken, setSessionCookie, verifyPassword,
} from './security'

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLocaleLowerCase())
const passwordSchema = z.string().min(12).max(128)
const DUMMY_PASSWORD_HASH = '$2b$12$ejCsF0sPtLGIpz0d2gbUTOl3Zq9AkbQS0OHGW0sUZ9.cFARk3jWpu'
const registerSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(120),
  password: passwordSchema,
  organizationName: z.string().trim().min(1).max(120).optional(),
})

function authRateLimit(max: number) {
  return { config: { rateLimit: { max, timeWindow: '15 minutes' } } }
}

function genericAuthError(reply: FastifyReply, message: string) {
  return reply.code(401).send({ error: message })
}

async function setVerificationToken(userId: string): Promise<string> {
  const token = secureToken()
  await query('DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2', [userId, 'VERIFY_EMAIL'])
  await query(
    `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)
     VALUES ($1, $2, 'VERIFY_EMAIL', now() + interval '24 hours')`,
    [digest(token), userId],
  )
  return token
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', authRateLimit(5), async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a valid name, email, and password with at least 12 characters.', issues: parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })) })
    if (!config.smtpEnabled) {
      return reply.code(503).send({
        error: 'Account registration is temporarily unavailable because email verification is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASSWORD, then restart the API.',
        code: 'EMAIL_NOT_CONFIGURED',
      })
    }
    const input = parsed.data
    const emailToken = secureToken()
    const slugBase = (input.organizationName ?? `${input.name} workspace`)
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || 'workspace'
    let userId: string
    try {
      userId = await transaction(async (client) => {
        const user = await client.query<{ id: string }>(
          `INSERT INTO users (email, name, password_hash)
           VALUES ($1, $2, $3) RETURNING id`,
          [input.email, input.name, await hashPassword(input.password)],
        )
        const organization = await client.query<{ id: string }>(
          `INSERT INTO organizations (name, slug)
           VALUES ($1, $2) RETURNING id`,
          [input.organizationName ?? `${input.name}'s workspace`, `${slugBase}-${randomUUID().slice(0, 8)}`],
        )
        await client.query(
          'INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)',
          [organization.rows[0].id, user.rows[0].id, 'OWNER'],
        )
        await client.query(
          `INSERT INTO subscriptions (organization_id, plan_id, provider, status)
           VALUES ($1, 'FREE', 'manual', 'free')`,
          [organization.rows[0].id],
        )
        await client.query(
          `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)
           VALUES ($1, $2, 'VERIFY_EMAIL', now() + interval '24 hours')`,
          [digest(emailToken), user.rows[0].id],
        )
        await client.query(
          `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id)
           VALUES ($1, $2, 'USER_REGISTERED', 'user', $3)`,
          [organization.rows[0].id, user.rows[0].id, user.rows[0].id],
        )
        return user.rows[0].id
      })
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'An account already exists for this email address.' })
      throw error
    }
    try {
      await sendVerification(input.email, input.name, emailToken)
      return reply.code(202).send({ verificationRequired: true, message: 'Check your email for a verification link before signing in.' })
    } catch (error) {
      request.log.error({ err: error, userId }, 'Email verification could not be delivered after account creation')
      return reply.code(503).send({
        verificationRequired: true,
        emailDeliveryFailed: true,
        code: 'EMAIL_DELIVERY_FAILED',
        message: 'Your account and free workspace were created, but the verification email could not be sent. Check the API log, configure working SMTP settings, then use “Reenviar verificação de e-mail” with this address.',
      })
    }
  })

  app.post('/api/auth/verify-email', authRateLimit(10), async (request, reply) => {
    const token = z.string().min(32).max(200).safeParse((request.body as { token?: unknown } | null)?.token)
    if (!token.success) return genericAuthError(reply, 'This verification link is invalid or expired.')
    const userId = await consumeToken(token.data, 'VERIFY_EMAIL', async (client, id) => {
      await client.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1', [id])
      await client.query('DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2', [id, 'VERIFY_EMAIL'])
      return id
    })
    if (!userId) return genericAuthError(reply, 'This verification link is invalid or expired.')
    const session = await createSession(userId)
    setSessionCookie(reply, session)
    await query(
      `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id)
       VALUES ($1, 'EMAIL_VERIFIED', 'user', $2)`,
      [userId, userId],
    )
    return reply.send({ verified: true })
  })

  app.post('/api/auth/resend-verification', authRateLimit(4), async (request, reply) => {
    const email = emailSchema.safeParse((request.body as { email?: unknown } | null)?.email)
    if (!email.success) return reply.code(400).send({ error: 'Enter a valid email address.' })
    if (!config.smtpEnabled) {
      return reply.code(503).send({
        error: 'Email verification cannot be sent because SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASSWORD, then restart the API.',
        code: 'EMAIL_NOT_CONFIGURED',
      })
    }
    const result = await query<{ id: string; name: string; email_verified_at: Date | null }>(
      'SELECT id, name, email_verified_at FROM users WHERE email = $1',
      [email.data],
    )
    if (result.rows[0] && !result.rows[0].email_verified_at) {
      const token = await setVerificationToken(result.rows[0].id)
      try {
        await sendVerification(email.data, result.rows[0].name, token)
      } catch (error) {
        request.log.error({ err: error, userId: result.rows[0].id }, 'Verification email resend failed')
        return reply.code(503).send({
          error: 'The verification email could not be delivered. Check the API log and SMTP settings, then try again.',
          code: 'EMAIL_DELIVERY_FAILED',
        })
      }
    }
    return reply.send({ message: 'If the account needs verification, a new link has been sent.' })
  })

  app.post('/api/auth/login', authRateLimit(8), async (request, reply) => {
    const parsed = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).safeParse(request.body)
    if (!parsed.success) return genericAuthError(reply, 'Invalid email or password.')
    const result = await query<{ id: string; email: string; name: string; password_hash: string; email_verified_at: Date | null }>(
      'SELECT id, email, name, password_hash, email_verified_at FROM users WHERE email = $1',
      [parsed.data.email],
    )
    const user = result.rows[0]
    const matched = await verifyPassword(parsed.data.password, user?.password_hash ?? DUMMY_PASSWORD_HASH)
    if (!user || !matched) return genericAuthError(reply, 'Invalid email or password.')
    if (!user.email_verified_at) return reply.code(403).send({ error: 'Confirm your email address before signing in.', verificationRequired: true })
    const sessionToken = await createSession(user.id)
    setSessionCookie(reply, sessionToken)
    await query(
      `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id)
       VALUES ($1, 'USER_LOGIN', 'user', $2)`,
      [user.id, user.id],
    )
    return reply.send({ user: { id: user.id, email: user.email, name: user.name, emailVerified: true } })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies.vista_session
    if (token) await query('DELETE FROM auth_sessions WHERE token_hash = $1', [digest(token)])
    clearSessionCookie(reply)
    return reply.code(204).send()
  })

  app.get('/api/auth/me', async (request, reply) => {
    try {
      const user = await requireUser(request)
      const organizations = await query(
        `SELECT o.id, o.name, o.slug, m.role, s.plan_id AS "planId", s.status
         FROM memberships m JOIN organizations o ON o.id = m.organization_id
         JOIN subscriptions s ON s.organization_id = o.id
         WHERE m.user_id = $1 ORDER BY o.created_at`,
        [user.id],
      )
      return { user, organizations: organizations.rows }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'FORBIDDEN') return reply.code(401).send({ user: null, organizations: [] })
      throw error
    }
  })

  app.post('/api/auth/forgot-password', authRateLimit(4), async (request, reply) => {
    const email = emailSchema.safeParse((request.body as { email?: unknown } | null)?.email)
    if (!email.success) return reply.code(400).send({ error: 'Enter a valid email address.' })
    if (!config.smtpEnabled) {
      return reply.code(503).send({
        error: 'Password recovery email cannot be sent because SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASSWORD, then restart the API.',
        code: 'EMAIL_NOT_CONFIGURED',
      })
    }
    const user = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email.data])
    if (user.rows[0]) {
      const token = secureToken()
      await query('DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2', [user.rows[0].id, 'RESET_PASSWORD'])
      await query(
        `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)
         VALUES ($1, $2, 'RESET_PASSWORD', now() + interval '1 hour')`,
        [digest(token), user.rows[0].id],
      )
      try {
        await sendPasswordRecovery(email.data, token)
      } catch (error) {
        request.log.error({ err: error, userId: user.rows[0].id }, 'Password recovery email delivery failed')
        return reply.code(503).send({
          error: 'The recovery email could not be delivered. Check the API log and SMTP settings, then try again.',
          code: 'EMAIL_DELIVERY_FAILED',
        })
      }
    }
    return reply.send({ message: 'If an account matches that email, recovery instructions have been sent.' })
  })

  app.post('/api/auth/reset-password', authRateLimit(5), async (request, reply) => {
    const parsed = z.object({ token: z.string().min(32).max(200), password: passwordSchema }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid recovery link and a password with at least 12 characters.' })
    const userId = await consumeToken(parsed.data.token, 'RESET_PASSWORD', async (client, id) => {
      const passwordHash = await hashPassword(parsed.data.password)
      await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [passwordHash, id])
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [id])
      await client.query('DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2', [id, 'RESET_PASSWORD'])
      return id
    })
    if (!userId) return genericAuthError(reply, 'This recovery link is invalid or expired.')
    await query(
      `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id)
       VALUES ($1, 'PASSWORD_RESET', 'user', $2)`,
      [userId, userId],
    )
    return reply.send({ passwordChanged: true, message: 'Password changed. Sign in with your new password.' })
  })

  app.post('/api/auth/change-password', async (request, reply) => {
    const user = await requireUser(request)
    const parsed = z.object({ currentPassword: z.string().min(1).max(128), password: passwordSchema }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'The new password must contain at least 12 characters.' })
    const result = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id])
    if (!result.rows[0] || !(await verifyPassword(parsed.data.currentPassword, result.rows[0].password_hash))) {
      return genericAuthError(reply, 'The current password is incorrect.')
    }
    await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await hashPassword(parsed.data.password), user.id])
    await query('DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, digest(request.cookies.vista_session!)])
    return reply.send({ passwordChanged: true })
  })

  app.post('/api/auth/invitations/accept', async (request, reply) => {
    const user = await requireUser(request)
    if (!user.emailVerified) return reply.code(403).send({ error: 'Verify your email before accepting an invitation.' })
    const token = z.string().min(32).max(200).safeParse((request.body as { token?: unknown } | null)?.token)
    if (!token.success) return reply.code(400).send({ error: 'The invitation link is invalid or expired.' })
    const accepted = await transaction(async (client) => {
      const invite = await client.query<{ id: string; organization_id: string; email: string; role: string; expires_at: Date }>(
        `SELECT id, organization_id, email, role, expires_at FROM invitations
         WHERE token_hash = $1 AND status = 'PENDING' FOR UPDATE`,
        [digest(token.data)],
      )
      const invitation = invite.rows[0]
      if (!invitation) return null
      if (invitation.expires_at.getTime() <= Date.now()) {
        await client.query(`UPDATE invitations SET status = 'EXPIRED' WHERE id = $1`, [invitation.id])
        return null
      }
      if (invitation.email.toLocaleLowerCase() !== user.email.toLocaleLowerCase()) return null
      const plan = await client.query<{ plan_id: 'FREE' | 'PRO' | 'BUSINESS'; status: 'free' | 'incomplete' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' }>(
        'SELECT plan_id, status FROM subscriptions WHERE organization_id = $1 FOR UPDATE',
        [invitation.organization_id],
      )
      if (!plan.rows[0]) return null
      const effectivePlan = effectivePlanId({ planId: plan.rows[0].plan_id, status: plan.rows[0].status })
      if (!hasEntitlement({ planId: plan.rows[0].plan_id, status: plan.rows[0].status }, 'team.members')) {
        return { limitReached: true as const }
      }
      const count = await client.query<{ value: string }>('SELECT count(*)::text AS value FROM memberships WHERE organization_id = $1', [invitation.organization_id])
      const limit = PLAN_CATALOG[effectivePlan].limits.maxMembers
      const memberCount = Number(count.rows[0]?.value ?? 0)
      if (limit >= 0 && memberCount >= limit) return { limitReached: true as const }
      await client.query(
        `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [invitation.organization_id, user.id, invitation.role],
      )
      await client.query(`UPDATE invitations SET status = 'ACCEPTED', accepted_at = now() WHERE id = $1`, [invitation.id])
      await client.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'INVITATION_ACCEPTED', 'invitation', $3)`,
        [invitation.organization_id, user.id, invitation.id],
      )
      return { organizationId: invitation.organization_id }
    })
    if (!accepted) return reply.code(404).send({ error: 'The invitation is invalid, expired, or addressed to another account.' })
    if ('limitReached' in accepted) return reply.code(409).send({ error: 'This organization has reached its member limit. Upgrade the plan to accept this invitation.' })
    return reply.send(accepted)
  })
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505'
}
