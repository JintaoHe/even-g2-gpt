import type { ConversationStore } from './conversation-store.js';
import { GuestUnlock } from './guest-unlock.js';
import { GuestAccessDenied, lockedDevicePrincipal, requireGuestAccess, type AccessPrincipal } from './guest-access.js';
import type { GuestRuntimePool } from './guest-runtime.js';
import { parseGuestModeCommand } from './guest-mode-protocol.js';

export type GuestAccessChanged = { type: 'access.changed'; mode: 'guest' | 'reauthorize';
  clear_display: true; clear_resume: true; reconnect: boolean };
export type GuestTransitionConnection = {
  connectionId: string; clientId: string; principal: AccessPrincipal;
  /** Synchronous, permanent input/output revocation plus capture cancellation.
   * Must not wait for socket close or cancel durable owner side effects. */
  cutOff(): void;
  /** Releases the registry lease without waiting for the peer's close ACK. */
  detach(): Promise<unknown>;
  /** The sole event allowed after cutOff; bypasses the ordinary data sink. */
  notify(event: GuestAccessChanged): void;
  close(): void;
};
type Entry = { connection: GuestTransitionConnection; epoch: number };

/** Authenticated transport adapter only. Registration never verifies a token:
 * it MUST be called after the existing hello credential + scope gates.
 * WebSocket dispatch opts in only with guest-capable clients and an isolated runtime pool. */
export class GuestModeController {
  private readonly connections = new Map<string, Entry>();
  private readonly unlock: GuestUnlock;
  private readonly changing = new Set<string>();
  private closed = false;
  constructor(private readonly store: ConversationStore, ownerToken: string,
    private readonly runtimes: Pick<GuestRuntimePool, 'releaseClient' | 'sweepInvalid'>,
    private readonly diagnostic: (event: { event: 'guest_transition_cleanup_failed' }) => void = () => {}) {
    this.unlock = new GuestUnlock(store, ownerToken);
  }

  registerAuthenticated(input: GuestTransitionConnection): void {
    if (this.closed || this.connections.has(input.connectionId)
      || !/^[a-f0-9-]{36}$/i.test(input.connectionId)) throw new GuestAccessDenied();
    requireGuestAccess(input.principal, 'conversation');
    // Snapshot identity; an adapter mutating its original object cannot elevate it.
    const connection = { ...input, principal: Object.freeze({ ...input.principal }) };
    const entry = { connection, epoch: this.store.getDeviceAccessEpoch(input.clientId) };
    this.check(entry);
    this.connections.set(input.connectionId, entry);
  }
  unregister(connectionId: string): void { this.unlock.cancel(connectionId); this.connections.delete(connectionId); }
  async handle(connectionId: string, input: unknown): Promise<void | { type: 'guest.unlock.challenge'; challenge: string; expires_in_seconds: 60 }> {
    this.get(connectionId);
    const message = parseGuestModeCommand(input);
    if (message.type === 'guest.enter') return this.enter(connectionId);
    if (message.type === 'guest.unlock.begin') return { type: 'guest.unlock.challenge', ...this.beginUnlock(connectionId) };
    return this.confirmUnlock(connectionId, message.challenge, message.owner_token);
  }
  private check(entry: Entry) {
    if (this.closed || this.changing.has(entry.connection.clientId)) throw new GuestAccessDenied();
    const { clientId, principal } = entry.connection;
    const current = lockedDevicePrincipal(this.store.getDeviceGuestLock(clientId),
      principal.mode === 'owner' ? principal.ownerScope : 'single-user');
    if (entry.epoch !== this.store.getDeviceAccessEpoch(clientId) || current.mode !== principal.mode
      || current.ownerScope !== principal.ownerScope
      || (current.mode === 'guest' && (principal.mode !== 'guest' || current.sessionId !== principal.sessionId))) {
      throw new GuestAccessDenied();
    }
    if (current.mode === 'guest') {
      const session = this.store.getSession(current.sessionId);
      if (!session || !['active', 'idle'].includes(session.status)) throw new GuestAccessDenied();
      requireGuestAccess(current, 'conversation', { ownerScope: session.ownerScope, sessionId: session.id });
    }
  }
  private get(connectionId: string) {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new GuestAccessDenied();
    this.check(entry); return entry;
  }
  private reportFailure() { try { this.diagnostic({ event: 'guest_transition_cleanup_failed' }); } catch { /* no data or exception prose */ } }

  private async revoke(clientId: string, initiator: string, event?: GuestAccessChanged) {
    const entries = [...this.connections.values()].filter(e => e.connection.clientId === clientId);
    // Remove every challenge and revoke EVERY connection before awaiting any cleanup.
    for (const { connection } of entries) {
      this.unregister(connection.connectionId);
      try { connection.cutOff(); } catch { this.reportFailure(); }
    }
    try { this.runtimes.releaseClient(clientId); } catch { this.reportFailure(); }
    const pending: Promise<unknown>[] = [];
    for (const { connection } of entries) {
      try { pending.push(Promise.resolve(connection.detach()).catch(() => this.reportFailure())); } catch { this.reportFailure(); }
      try { if (event && connection.connectionId === initiator) connection.notify(event); } catch { this.reportFailure(); }
      finally { try { connection.close(); } catch { this.reportFailure(); } }
    }
    await Promise.all(pending);
  }

  async enter(connectionId: string): Promise<void> {
    const { connection } = this.get(connectionId);
    if (connection.principal.mode !== 'owner') throw new GuestAccessDenied();
    this.changing.add(connection.clientId);
    let committed = false;
    try {
      // No await between validation and SQLite commit. Do not report guest mode before commit.
      this.store.enterDeviceGuestMode({ clientId: connection.clientId, at: Date.now() });
      committed = true;
    } finally {
      try { await this.revoke(connection.clientId, connectionId, committed ? {
        type: 'access.changed', mode: 'guest', clear_display: true, clear_resume: true, reconnect: true,
      } : undefined); } finally { this.changing.delete(connection.clientId); }
    }
  }

  beginUnlock(connectionId: string): { challenge: string; expires_in_seconds: 60 } {
    const { connection } = this.get(connectionId);
    if (connection.principal.mode !== 'guest') throw new GuestAccessDenied();
    return { challenge: this.unlock.begin(connectionId, connection.clientId), expires_in_seconds: 60 };
  }
  async confirmUnlock(connectionId: string, challenge: unknown, freshOwnerToken: unknown): Promise<void> {
    const { connection } = this.get(connectionId);
    if (connection.principal.mode !== 'guest') throw new GuestAccessDenied();
    // Failed credential attempts consume their challenge but do not report unlocked.
    this.unlock.confirm({ connectionId, clientId: connection.clientId, challenge, ownerToken: freshOwnerToken, at: Date.now() });
    this.changing.add(connection.clientId);
    try { await this.revoke(connection.clientId, connectionId, {
      type: 'access.changed', mode: 'reauthorize', clear_display: true, clear_resume: true, reconnect: false,
    }); } finally { this.changing.delete(connection.clientId); }
  }

  /** Expiry, external unlock and rebind hooks. The server sweep must call this
   * as well; explicit hooks are not the only line of defence. */
  async sweepInvalid(): Promise<void> {
    const invalid = new Set<string>();
    for (const entry of this.connections.values()) try { this.check(entry); } catch { invalid.add(entry.connection.clientId); }
    for (const clientId of invalid) await this.revoke(clientId, '');
    this.runtimes.sweepInvalid();
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const clientId of new Set([...this.connections.values()].map(e => e.connection.clientId))) await this.revoke(clientId, '');
  }
}
