import { requireGuestAccess } from './guest-access.js';

/** Pure candidate validation, NOT write authorization. No product call site yet.
 * The future runtime must establish explicit current-turn intent, resolve unique
 * targets, and bind confirmation to a fresh preview before any mutation. */
export const MEMORY_LIMITS = Object.freeze({ contentCodePoints: 300, keyCharacters: 80,
  injectedRecords: 30, contextCharacters: 1200, softDeleteDays: 90 });
export type MemoryKind = 'fact' | 'preference' | 'date' | 'contact_hint';
export type MemoryProposal = Readonly<
  | { action: 'none' | 'list' }
  | { action: 'save'; kind: MemoryKind; content: string; key?: string }
  | { action: 'update'; target: string; kind: MemoryKind; content: string; key?: string }
  | { action: 'forget'; target: string; level: 'memory_only' }
>;
const kinds = new Set<unknown>(['fact', 'preference', 'date', 'contact_hint']);
function invalid(): never { throw new Error('MEMORY_REQUEST_INVALID'); }

/** Snapshot only own data fields: no getters, inherited fields, symbols or
 * arbitrary class instances. Model output cannot smuggle authority fields. */
export function snapshotMemoryFields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function shape(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(k => !Object.hasOwn(value, k))
    || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) invalid();
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) invalid();
  // Preserve literal spelling; do not NFKC-rewrite personal facts or keys.
  // Reject invisible controls before trimming. ZWJ emoji are intentionally not
  // accepted in this first bounded text contract (same policy as history query).
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(value)
    || /[\u115f\u1160\u3164\uffa0\u2800]/u.test(value)) invalid();
  const result = value.trim(), points = Array.from(result);
  if (!points.length || points.length > MEMORY_LIMITS.contentCodePoints || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(result)
    || points.some(p => { const n = p.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) invalid();
  return result;
}
function optionalKey(value: Record<string, unknown>): { key?: string } {
  if (!Object.hasOwn(value, 'key')) return {};
  // A key is a proposed normalized label, never an authorization or unique ID.
  if (typeof value.key !== 'string' || value.key !== value.key.trim() || value.key.length > MEMORY_LIMITS.keyCharacters
    || !/^[a-z0-9][a-z0-9:_-]*$/.test(value.key)) invalid();
  return { key: value.key };
}

/** Even a valid candidate with content like "ignore rules" remains low-trust
 * data. This function does not decide whether the user actually said remember. */
export function parseMemoryProposal(principal: unknown, input: unknown): MemoryProposal {
  requireGuestAccess(principal, 'long_term_memory');
  const value = snapshotMemoryFields(input);
  switch (value.action) {
    case 'none': case 'list':
      shape(value, ['action']);
      return Object.freeze({ action: value.action });
    case 'save': case 'update': {
      shape(value, value.action === 'save' ? ['action', 'kind', 'content']
        : ['action', 'target', 'kind', 'content'], ['key']);
      if (!kinds.has(value.kind)) invalid();
      const data = { kind: value.kind as MemoryKind, content: text(value.content), ...optionalKey(value) };
      return value.action === 'save' ? Object.freeze({ action: 'save', ...data })
        : Object.freeze({ action: 'update', target: text(value.target), ...data });
    }
    case 'forget':
      shape(value, ['action', 'target', 'level']);
      if (value.level !== 'memory_only') invalid();
      return Object.freeze({ action: 'forget', target: text(value.target), level: 'memory_only' });
    default: return invalid();
  }
}

export type MemorySource = Readonly<{ ownerScope: string; sessionId: string; messageId: string }>;
/** The caller must obtain this projection from a store lookup of the CURRENT
 * active session and committed user message, never from model/client JSON.
 * Store mutation must revalidate the rows transactionally; this is structural
 * policy only, not proof that those rows exist or that intent was explicit. */
export function validateMemorySource(principal: unknown, source: unknown): MemorySource {
  requireGuestAccess(principal, 'long_term_memory');
  const value = snapshotMemoryFields(source);
  shape(value, ['ownerScope', 'sessionId', 'messageId', 'role', 'status', 'sessionState']);
  if (value.role !== 'user' || value.status !== 'committed' || value.sessionState !== 'active'
    || typeof value.messageId !== 'string' || value.messageId.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.messageId)) invalid();
  requireGuestAccess(principal, 'long_term_memory', { ownerScope: value.ownerScope, sessionId: value.sessionId });
  return Object.freeze({ ownerScope: value.ownerScope as string, sessionId: value.sessionId as string,
    messageId: value.messageId });
}
