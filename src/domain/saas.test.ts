import { describe, expect, it } from 'vitest'
import { assertEntitlement, assertWithinLimit, authorizeRole, canAccessTenantResource, canManageRole, effectivePlanId, getUsage, PLAN_CATALOG } from './saas'

describe('tenant access and roles', () => {
  it('allows a member to access their tenant project and denies cross-tenant access', () => {
    const membershipA = { userId: 'user-a', organizationId: 'org-a' }
    expect(canAccessTenantResource(membershipA, 'user-a', 'org-a')).toBe(true)
    expect(canAccessTenantResource(membershipA, 'user-a', 'org-b')).toBe(false)
    expect(canAccessTenantResource(membershipA, 'user-b', 'org-a')).toBe(false)
  })

  it('enforces role capabilities for management operations', () => {
    expect(() => authorizeRole('VIEWER', 'projects.write')).toThrow()
    expect(() => authorizeRole('MEMBER', 'projects.write')).not.toThrow()
    expect(() => authorizeRole('ADMIN', 'members.manage')).not.toThrow()
    expect(() => authorizeRole('ADMIN', 'billing.manage')).toThrow()
    expect(canManageRole('ADMIN', 'MEMBER', 'VIEWER')).toBe(true)
    expect(canManageRole('ADMIN', 'OWNER', 'VIEWER')).toBe(false)
    expect(canManageRole('OWNER', 'OWNER', 'ADMIN')).toBe(false)
  })
})

describe('plans and limits', () => {
  it('includes configurable plan entitlements and usage limits', () => {
    expect(PLAN_CATALOG.FREE.limits.maxProjects).toBe(3)
    expect(PLAN_CATALOG.BUSINESS.limits.maxProjects).toBe(-1)
    expect(PLAN_CATALOG.PRO.entitlements.has('team.members')).toBe(true)
    expect(PLAN_CATALOG.FREE.entitlements.has('team.members')).toBe(false)
  })

  it('reports usage and blocks new items without deleting existing data', () => {
    expect(getUsage(2, 3)).toEqual({ usage: 2, limit: 3, remaining: 1 })
    expect(getUsage(25, -1)).toEqual({ usage: 25, limit: -1, remaining: null })
    expect(() => assertWithinLimit(2, 3)).not.toThrow()
    expect(() => assertWithinLimit(3, 3)).toThrow(/Existing data is preserved/)
    expect(() => assertWithinLimit(500, -1)).not.toThrow()
  })

  it('does not grant premium entitlements from an unpaid or canceled subscription', () => {
    expect(() => assertEntitlement({ organizationId: 'org', planId: 'PRO', status: 'incomplete' }, 'team.members')).toThrow()
    expect(() => assertEntitlement({ organizationId: 'org', planId: 'PRO', status: 'active' }, 'team.members')).not.toThrow()
    expect(effectivePlanId({ planId: 'PRO', status: 'active' })).toBe('PRO')
    expect(effectivePlanId({ planId: 'PRO', status: 'past_due' })).toBe('FREE')
  })
})
