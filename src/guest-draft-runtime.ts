import type { ConversationStore } from './conversation-store.js';
import { ContextBuilder } from './context-builder.js';
import type { DraftGenerator } from './delivery-draft.js';
import { lockedDevicePrincipal, requireGuestAccess, type AccessPrincipal } from './guest-access.js';

/** Internal capability-limited component, not a transport authentication entry.
 * It cannot access JobStore, mail, calendar, CLI or another session's history.
 * The caller must authenticate before constructing it. */
export class GuestDraftRuntime {
  private readonly principal: Extract<AccessPrincipal, { mode: 'guest' }>;
  private readonly epoch: number;
  private busy = false;

  constructor(private readonly store: ConversationStore, private readonly clientId: string,
    principal: AccessPrincipal, private readonly generate: DraftGenerator) {
    requireGuestAccess(principal, 'draft_create');
    if (principal.mode !== 'guest') throw new Error('GUEST_ACCESS_DENIED');
    this.principal = Object.freeze({ ...principal });
    this.epoch = store.getDeviceAccessEpoch(clientId);
    this.check();
  }

  private check() {
    const current = lockedDevicePrincipal(this.store.getDeviceGuestLock(this.clientId), 'single-user');
    const session = this.store.getSession(this.principal.sessionId);
    if (current.mode !== 'guest' || current.sessionId !== this.principal.sessionId
      || current.ownerScope !== this.principal.ownerScope
      || this.store.getDeviceAccessEpoch(this.clientId) !== this.epoch
      || !session || !['active', 'idle'].includes(session.status)) throw new Error('GUEST_ACCESS_DENIED');
    requireGuestAccess(this.principal, 'draft_read', { ownerScope: session.ownerScope, sessionId: session.id });
    return session;
  }

  read(id?: string) {
    this.check();
    return this.store.readGuestDraft(this.principal, id);
  }

  async create(kind: 'document' | 'revise', signal: AbortSignal) {
    if (kind !== 'document' && kind !== 'revise') throw new Error('GUEST_ACCESS_DENIED');
    signal.throwIfAborted();
    const session = this.check();
    if (this.busy) throw new Error('GUEST_DRAFT_BUSY');
    this.store.assertGuestDraftCapacity(this.principal);
    const previous = kind === 'revise' ? this.read() : undefined;
    if (kind === 'revise' && !previous) throw new Error('GUEST_DRAFT_NOT_FOUND');
    const history = new ContextBuilder().build({
      messages: this.store.listRecentMessages(session.id, 100)
        .filter(m => m.status === 'committed' && m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, topicId: m.topicId,
          sequence: m.sequence, status: m.status })),
      summary: this.store.latestSummary(session.id),
    }).messages;
    this.busy = true;
    try {
      const result = await this.generate(history, kind, previous ? { document: previous.document } : undefined, signal);
      signal.throwIfAborted();
      this.check(); // Unlock/rebind during generation can never publish a late result.
      if ('clarification' in result) return result;
      if (result.calendar !== undefined) throw new Error('GUEST_ACCESS_DENIED');
      return this.store.saveGuestDraft(this.principal, result.document, Date.now());
    } finally { this.busy = false; }
  }
}
