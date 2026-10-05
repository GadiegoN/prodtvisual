import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import { config } from './config'
import { query, transaction } from './db'
import { requireOrganization, requireUser, recordAudit } from './security'
import type { AuthenticatedOrganization } from './security'

export type PaidPlan = 'PRO' | 'BUSINESS'

export interface BillingProvider {
  createCheckout(organization: AuthenticatedOrganization, email: string, plan: PaidPlan): Promise<string>
  createPortal(organization: AuthenticatedOrganization): Promise<string>
  changePlan(organization: AuthenticatedOrganization, plan: PaidPlan): Promise<void>
  cancelSubscription(organization: AuthenticatedOrganization): Promise<void>
  processWebhook(rawBody: Buffer, signature: string): Promise<{ duplicate: boolean }>
}

export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe

  constructor() {
    if (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe billing is not configured.')
    this.stripe = new Stripe(config.STRIPE_SECRET_KEY)
  }

  private price(plan: PaidPlan): string {
    const price = plan === 'PRO' ? config.STRIPE_PRICE_PRO_MONTHLY : config.STRIPE_PRICE_BUSINESS_MONTHLY
    if (!price) throw new Error(`Set the Stripe recurring price ID for the ${plan} plan.`)
    return price
  }

  async createCheckout(organization: AuthenticatedOrganization, email: string, plan: PaidPlan): Promise<string> {
    const current = await query<{ provider_customer_id: string | null }>(
      'SELECT provider_customer_id FROM subscriptions WHERE organization_id = $1',
      [organization.id],
    )
    let customerId = current.rows[0]?.provider_customer_id
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        name: organization.name,
        email,
        metadata: { organization_id: organization.id },
      }, { idempotencyKey: `vista-customer-${organization.id}` })
      customerId = customer.id
      await query('UPDATE subscriptions SET provider_customer_id = $1 WHERE organization_id = $2 AND provider_customer_id IS NULL', [customerId, organization.id])
    }
    const checkout = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: this.price(plan), quantity: 1 }],
      success_url: new URL('/?billing=success', config.APP_ORIGIN).toString(),
      cancel_url: new URL('/?billing=cancelled', config.APP_ORIGIN).toString(),
      client_reference_id: organization.id,
      metadata: { organization_id: organization.id, plan_id: plan },
      subscription_data: { metadata: { organization_id: organization.id, plan_id: plan } },
    }, { idempotencyKey: `vista-checkout-${organization.id}-${plan}-${Date.now()}` })
    if (!checkout.url) throw new Error('Stripe did not return a checkout URL.')
    return checkout.url
  }

  async createPortal(organization: AuthenticatedOrganization): Promise<string> {
    const result = await query<{ provider_customer_id: string | null }>(
      'SELECT provider_customer_id FROM subscriptions WHERE organization_id = $1',
      [organization.id],
    )
    if (!result.rows[0]?.provider_customer_id) throw new Error('This organization does not have a Stripe customer yet.')
    const portal = await this.stripe.billingPortal.sessions.create({
      customer: result.rows[0].provider_customer_id,
      return_url: new URL('/?settings=billing', config.APP_ORIGIN).toString(),
    })
    return portal.url
  }

  async changePlan(organization: AuthenticatedOrganization, plan: PaidPlan): Promise<void> {
    const result = await query<{ provider_subscription_id: string | null }>(
      'SELECT provider_subscription_id FROM subscriptions WHERE organization_id = $1',
      [organization.id],
    )
    const subscriptionId = result.rows[0]?.provider_subscription_id
    if (!subscriptionId) throw new Error('Start a Stripe subscription before changing plan.')
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId)
    const item = subscription.items.data[0]
    if (!item) throw new Error('The Stripe subscription has no plan item.')
    await this.stripe.subscriptions.update(subscriptionId, {
      items: [{ id: item.id, price: this.price(plan) }],
      proration_behavior: 'create_prorations',
      metadata: { ...subscription.metadata, plan_id: plan },
    }, { idempotencyKey: `vista-plan-${subscriptionId}-${plan}-${item.price.id}` })
  }

  async cancelSubscription(organization: AuthenticatedOrganization): Promise<void> {
    const result = await query<{ provider_subscription_id: string | null }>(
      'SELECT provider_subscription_id FROM subscriptions WHERE organization_id = $1',
      [organization.id],
    )
    const subscriptionId = result.rows[0]?.provider_subscription_id
    if (!subscriptionId) throw new Error('This organization has no active Stripe subscription.')
    await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true })
  }

  async processWebhook(rawBody: Buffer, signature: string): Promise<{ duplicate: boolean }> {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET!)
    return transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO billing_events (provider_event_id, event_type)
         VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING provider_event_id`,
        [event.id, event.type],
      )
      if (!inserted.rows.length) return { duplicate: true }
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object
          if (session.mode !== 'subscription' || typeof session.subscription !== 'string') break
          const subscription = await this.stripe.subscriptions.retrieve(session.subscription)
          await this.persistSubscription(client, subscription)
          break
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await this.persistSubscription(client, event.data.object)
          break
        case 'invoice.payment_failed':
        case 'invoice.paid': {
          const invoice = event.data.object
          const subscription = invoice.parent?.type === 'subscription_details'
            ? invoice.parent.subscription_details?.subscription
            : null
          const subscriptionId = typeof subscription === 'string' ? subscription : subscription?.id ?? null
          if (subscriptionId) {
            const subscriptions = await client.query<{ organization_id: string }>(
              `SELECT organization_id FROM subscriptions WHERE provider_subscription_id = $1`,
              [subscriptionId],
            )
            if (event.type === 'invoice.payment_failed') {
              await client.query(
                `UPDATE subscriptions SET status = 'past_due', updated_at = now()
                 WHERE provider_subscription_id = $1 AND status IN ('active', 'trialing', 'past_due')`,
                [subscriptionId],
              )
            }
            for (const row of subscriptions.rows) {
              await client.query(
                `INSERT INTO audit_logs (organization_id, action, resource_type, resource_id)
                 VALUES ($1, $2, 'subscription', $3)`,
                [row.organization_id, event.type === 'invoice.paid' ? 'PAYMENT_RECEIVED' : 'PAYMENT_FAILED', subscriptionId],
              )
            }
          }
          break
        }
        default:
          break
      }
      return { duplicate: false }
    })
  }

  private async persistSubscription(client: import('pg').PoolClient, subscription: Stripe.Subscription): Promise<void> {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
    const result = await client.query<{ organization_id: string; plan_id: string }>(
      `SELECT organization_id, plan_id FROM subscriptions
       WHERE provider_customer_id = $1 FOR UPDATE`,
      [customerId],
    )
    const organizationId = result.rows[0]?.organization_id ?? subscription.metadata.organization_id
    if (!organizationId) return
    const priceId = subscription.items.data[0]?.price.id
    const planId: PaidPlan | null = priceId === config.STRIPE_PRICE_BUSINESS_MONTHLY ? 'BUSINESS' :
      priceId === config.STRIPE_PRICE_PRO_MONTHLY ? 'PRO' : null
    if (!planId) throw new Error(`Stripe subscription ${subscription.id} uses an unconfigured recurring price.`)
    const status = subscription.status === 'active' || subscription.status === 'trialing' || subscription.status === 'past_due' ||
      subscription.status === 'canceled' || subscription.status === 'unpaid' || subscription.status === 'incomplete'
      ? subscription.status
      : 'incomplete'
    await client.query(
      `UPDATE subscriptions SET plan_id = $1, provider = 'stripe', provider_customer_id = $2,
       provider_subscription_id = $3, status = $4, cancel_at_period_end = $5,
       current_period_start = to_timestamp($6), current_period_end = to_timestamp($7), updated_at = now()
       WHERE organization_id = $8`,
      [planId, customerId, subscription.id, status, subscription.cancel_at_period_end,
        subscription.items.data[0]?.current_period_start ?? null,
        subscription.items.data[0]?.current_period_end ?? null, organizationId],
    )
    await client.query(
      `INSERT INTO audit_logs (organization_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'subscription', $3, $4::jsonb)`,
      [organizationId, subscription.status === 'canceled' ? 'SUBSCRIPTION_CANCELED' : 'PLAN_CHANGED', subscription.id,
        JSON.stringify({ planId, status })],
    )
  }
}

export async function registerBillingRoutes(app: FastifyInstance, billing: BillingProvider | null): Promise<void> {
  app.get('/api/plans', async () => ({
    plans: [
      { id: 'FREE', name: 'Free', features: ['3 projetos', '3 datasets', '1 membro', 'Até 10.000 linhas por dataset'] },
      { id: 'PRO', name: 'Pro', features: ['100 projetos', 'Até 10 membros', 'Até 1.000.000 linhas por dataset'] },
      { id: 'BUSINESS', name: 'Business', features: ['Projetos e membros ilimitados', 'Até 5.000.000 linhas por dataset', 'Acesso à API'] },
    ],
  }))

  app.get('/api/billing/subscription', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request) },
  }, async (request) => {
    const organization = request.organization!
    const result = await query(
      `SELECT s.plan_id AS "planId", s.status, s.current_period_start AS "periodStart",
       s.current_period_end AS "periodEnd", s.cancel_at_period_end AS "cancelAtPeriodEnd",
       s.provider_subscription_id IS NOT NULL AS "managedByStripe"
       FROM subscriptions s WHERE s.organization_id = $1`,
      [organization.id],
    )
    return { subscription: result.rows[0] ?? null }
  })

  app.post('/api/billing/checkout', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'billing.manage') },
  }, async (request, reply) => {
    if (!billing) return reply.code(503).send({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and recurring price IDs to enable real checkout.' })
    const plan = (request.body as { plan?: string } | null)?.plan
    if (plan !== 'PRO' && plan !== 'BUSINESS') return reply.code(400).send({ error: 'Choose a supported paid plan.' })
    const url = await billing.createCheckout(request.organization!, request.user!.email, plan)
    return { url }
  })

  app.post('/api/billing/portal', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'billing.manage') },
  }, async (request, reply) => {
    if (!billing) return reply.code(503).send({ error: 'Stripe billing is not configured.' })
    return { url: await billing.createPortal(request.organization!) }
  })

  app.post('/api/billing/change-plan', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'billing.manage') },
  }, async (request, reply) => {
    if (!billing) return reply.code(503).send({ error: 'Stripe billing is not configured.' })
    const plan = (request.body as { plan?: string } | null)?.plan
    if (plan !== 'PRO' && plan !== 'BUSINESS') return reply.code(400).send({ error: 'Choose a supported paid plan.' })
    await billing.changePlan(request.organization!, plan)
    return reply.code(202).send({ message: 'Plan change requested; access updates only after a verified Stripe webhook.' })
  })

  app.post('/api/billing/cancel', {
    preHandler: async (request) => { await requireUser(request); await requireOrganization(request, 'billing.manage') },
  }, async (request, reply) => {
    if (!billing) return reply.code(503).send({ error: 'Stripe billing is not configured.' })
    await billing.cancelSubscription(request.organization!)
    return reply.code(202).send({ message: 'Cancellation requested; the current plan stays active until the paid period ends.' })
  })

  app.post('/api/billing/webhook', { config: { rawBody: true } }, async (request, reply) => {
    if (!billing) return reply.code(503).send({ error: 'Stripe webhooks are not configured.' })
    const signature = request.headers['stripe-signature']
    if (typeof signature !== 'string' || !Buffer.isBuffer(request.rawBody)) return reply.code(400).send({ error: 'The signed raw Stripe request is required.' })
    try {
      const result = await billing.processWebhook(request.rawBody, signature)
      return reply.send({ received: true, duplicate: result.duplicate })
    } catch (error) {
      request.log.warn({ err: error }, 'Stripe webhook signature or processing failed')
      return reply.code(400).send({ error: 'The Stripe webhook could not be verified or processed.' })
    }
  })
}
