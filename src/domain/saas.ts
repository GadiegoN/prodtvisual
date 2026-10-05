export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'
export type PlanId = 'FREE' | 'PRO' | 'BUSINESS'
export type Entitlement =
  | 'projects.create' | 'datasets.import' | 'dashboard.create'
  | 'export.csv' | 'export.png' | 'export.svg' | 'export.pdf'
  | 'share.public' | 'team.members' | 'custom_branding' | 'api.access'
export type UsageLimit = 'maxProjects' | 'maxDatasets' | 'maxMembers' | 'maxStorage' | 'maxRowsPerDataset' | 'maxDashboards' | 'maxExportsPerMonth'

export interface PlanDefinition {
  id: PlanId
  name: string
  entitlements: ReadonlySet<Entitlement>
  limits: Readonly<Record<UsageLimit, number>>
}

export interface OrganizationPlan {
  organizationId: string
  planId: PlanId
  status: 'free' | 'incomplete' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid'
}

type EntitlementPlan = Pick<OrganizationPlan, 'planId' | 'status'> & Partial<Pick<OrganizationPlan, 'organizationId'>>

export interface Usage {
  usage: number
  limit: number
  remaining: number | null
}

export const PLAN_CATALOG: Readonly<Record<PlanId, PlanDefinition>> = {
  FREE: {
    id: 'FREE', name: 'Free',
    entitlements: new Set(['projects.create', 'datasets.import', 'dashboard.create', 'export.csv', 'export.png', 'export.svg', 'export.pdf', 'share.public']),
    limits: { maxProjects: 3, maxDatasets: 3, maxMembers: 1, maxStorage: 50 * 1024 * 1024, maxRowsPerDataset: 10_000, maxDashboards: 1, maxExportsPerMonth: 100 },
  },
  PRO: {
    id: 'PRO', name: 'Pro',
    entitlements: new Set(['projects.create', 'datasets.import', 'dashboard.create', 'export.csv', 'export.png', 'export.svg', 'export.pdf', 'share.public', 'team.members']),
    limits: { maxProjects: 100, maxDatasets: 100, maxMembers: 10, maxStorage: 5 * 1024 * 1024 * 1024, maxRowsPerDataset: 1_000_000, maxDashboards: 20, maxExportsPerMonth: 10_000 },
  },
  BUSINESS: {
    id: 'BUSINESS', name: 'Business',
    entitlements: new Set(['projects.create', 'datasets.import', 'dashboard.create', 'export.csv', 'export.png', 'export.svg', 'export.pdf', 'share.public', 'team.members', 'custom_branding', 'api.access']),
    limits: { maxProjects: -1, maxDatasets: -1, maxMembers: -1, maxStorage: 100 * 1024 * 1024 * 1024, maxRowsPerDataset: 5_000_000, maxDashboards: -1, maxExportsPerMonth: -1 },
  },
}

export class SaaSError extends Error {
  constructor(message: string, readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'LIMIT_REACHED' | 'PLAN_REQUIRED') {
    super(message)
    this.name = 'SaaSError'
  }
}

const permissions: Readonly<Record<OrganizationRole, ReadonlySet<string>>> = {
  OWNER: new Set(['organization.read', 'organization.update', 'organization.delete', 'billing.manage', 'members.manage', 'projects.read', 'projects.write', 'projects.delete', 'sharing.manage']),
  ADMIN: new Set(['organization.read', 'members.manage', 'projects.read', 'projects.write', 'projects.delete', 'sharing.manage']),
  MEMBER: new Set(['organization.read', 'projects.read', 'projects.write', 'sharing.manage']),
  VIEWER: new Set(['organization.read', 'projects.read']),
}

export function authorizeRole(role: OrganizationRole, permission: string): void {
  if (!permissions[role]?.has(permission)) throw new SaaSError('This role is not permitted to perform that operation.', 'FORBIDDEN')
}

export function canAccessTenantResource(membership: { userId: string; organizationId: string } | null, userId: string, resourceOrganizationId: string): boolean {
  return membership !== null && membership.userId === userId && membership.organizationId === resourceOrganizationId
}

export function hasEntitlement(plan: EntitlementPlan, entitlement: Entitlement): boolean {
  if (!['free', 'trialing', 'active'].includes(plan.status)) return false
  return PLAN_CATALOG[plan.planId].entitlements.has(entitlement)
}

export function effectivePlanId(plan: Pick<OrganizationPlan, 'planId' | 'status'>): PlanId {
  return ['free', 'trialing', 'active'].includes(plan.status) ? plan.planId : 'FREE'
}

export function assertEntitlement(plan: EntitlementPlan, entitlement: Entitlement): void {
  if (!hasEntitlement(plan, entitlement)) throw new SaaSError('This feature is not available on the current organization plan.', 'PLAN_REQUIRED')
}

export function getUsage(usage: number, limit: number): Usage {
  return { usage, limit, remaining: limit < 0 ? null : Math.max(0, limit - usage) }
}

export function assertWithinLimit(usage: number, limit: number, itemSize = 1): void {
  if (limit >= 0 && usage + itemSize > limit) {
    throw new SaaSError('The organization has reached this plan limit. Existing data is preserved; upgrade or remove content to continue.', 'LIMIT_REACHED')
  }
}

export function canManageRole(actor: OrganizationRole, target: OrganizationRole, next?: OrganizationRole): boolean {
  if (actor === 'OWNER') return !(target === 'OWNER' && next !== undefined && next !== 'OWNER')
  if (actor === 'ADMIN') return target !== 'OWNER' && target !== 'ADMIN' && next !== 'OWNER'
  return false
}
