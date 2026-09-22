/** Pure policy only. Authentication, durable locks and transport enforcement
 * must be wired before the product may advertise an isolated guest mode. */
export type GuestCapability = 'conversation' | 'routes' | 'search' | 'draft_create' | 'draft_read'
  | 'prior_context' | 'history_search' | 'long_term_memory'
  | 'calendar' | 'email' | 'cli' | 'jobs_list' | 'calendar_list' | 'artifact';
export type AccessPrincipal =
  | { mode: 'owner'; ownerScope: string }
  | { mode: 'guest'; ownerScope: string; sessionId: string };
export type DeviceGuestLock = { guestScope: string; sessionId: string };
export class GuestAccessDenied extends Error {
  readonly code = 'GUEST_ACCESS_DENIED';
  constructor() { super('GUEST_ACCESS_DENIED'); }
}
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const isGuestScope = (value: unknown): value is string => typeof value === 'string'
  && value.length === 42 && value.startsWith('guest:') && uuid(value.slice(6));
const isOwnerScope = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 128 && value === value.trim()
  && !/^\s*guest\s*:/i.test(value) && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value);
const publicCapabilities = new Set<unknown>(['conversation', 'routes', 'search', 'draft_create', 'draft_read']);
const capabilities = new Set<unknown>([...publicCapabilities, 'prior_context', 'history_search', 'long_term_memory',
  'calendar', 'email', 'cli', 'jobs_list', 'calendar_list', 'artifact']);
const resourceRequired = new Set<unknown>(['draft_read', 'artifact']);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => {
    const descriptor = Object.getOwnPropertyDescriptor(value, k);
    return !!descriptor && Object.hasOwn(descriptor, 'value');
  });
}
function validPrincipal(value: unknown): value is AccessPrincipal {
  if (!record(value)) return false;
  const mode = Object.getOwnPropertyDescriptor(value, 'mode')?.value;
  if (mode === 'owner') return exactKeys(value, ['mode', 'ownerScope']) && isOwnerScope(value.ownerScope);
  if (mode === 'guest') return exactKeys(value, ['mode', 'ownerScope', 'sessionId'])
    && isGuestScope(value.ownerScope) && uuid(value.sessionId);
  return false;
}

/** A command must occupy the whole utterance. Quoting, negating or discussing
 * the phrase never changes identity. No model interpretation authorizes this. */
export function requestsGuestMode(text: unknown): boolean {
  if (typeof text !== 'string') throw new Error('INVALID_GUEST_COMMAND');
  if (text.length > 256) return false;
  const normalized = text.normalize('NFKC').trim().toLowerCase();
  // Question marks, quotation and appended clauses are not activation commands.
  return /^(?:(?:(?:进入|進入|开启|開啟|切换到|切換到)\s*)?[访訪]\s*客\s*模\s*式|(?:(?:enter|enable|switch\s+to)\s+)?guest[\s-]+mode)[\s。.!！,，、…~～]*$/u.test(normalized);
}

/** Called only after credential verification. The durable device lock wins over
 * omitted/false guest flags, device credentials, reconnects and new sessions.
 * Unlocking is deliberately not represented by a client-supplied boolean. */
export function lockedDevicePrincipal(lock: unknown, ownerScope: unknown): AccessPrincipal {
  if (lock === undefined) {
    if (!isOwnerScope(ownerScope)) throw new GuestAccessDenied();
    return { mode: 'owner', ownerScope };
  }
  if (!record(lock) || !exactKeys(lock, ['guestScope', 'sessionId'])
    || !isGuestScope(lock.guestScope) || !uuid(lock.sessionId)) throw new GuestAccessDenied();
  return { mode: 'guest', ownerScope: lock.guestScope, sessionId: lock.sessionId };
}

/** Resource ownership is checked independently of capability. In particular a
 * public drafting capability does not confer access to old owner documents. */
export function requireGuestAccess(principal: unknown, capability: unknown, resource?: unknown): void {
  if (!validPrincipal(principal) || !capabilities.has(capability)) throw new GuestAccessDenied();
  if (resourceRequired.has(capability) && resource === undefined) throw new GuestAccessDenied();
  if (resource !== undefined && (!record(resource) || !exactKeys(resource, ['ownerScope', 'sessionId'])
    || !(isGuestScope(resource.ownerScope) || isOwnerScope(resource.ownerScope)) || !uuid(resource.sessionId))) {
    throw new GuestAccessDenied();
  }
  const target = resource as { ownerScope: string; sessionId: string } | undefined;
  if (principal.mode === 'guest') {
    if (!publicCapabilities.has(capability)) throw new GuestAccessDenied();
    if (target && (target.ownerScope !== principal.ownerScope || target.sessionId !== principal.sessionId)) {
      throw new GuestAccessDenied();
    }
  } else if (target && target.ownerScope !== principal.ownerScope) {
    throw new GuestAccessDenied();
  }
}

export function requireGuestResume(principal: unknown, resource: unknown): void {
  if (resource === undefined) throw new GuestAccessDenied();
  requireGuestAccess(principal, 'conversation', resource);
}
