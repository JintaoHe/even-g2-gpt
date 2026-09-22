import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ConversationStore } from './conversation-store.js';
import { GuestAccessDenied, type DeviceGuestLock } from './guest-access.js';

type Challenge = { clientId: string; secret: string; lock: DeviceGuestLock; issuedAt: number };
/** Internal authorization primitive, not a transport handler. Call begin only
 * after authenticating the client; cancel on disconnect or identity transition.
 * A new service/connection cannot reuse an earlier challenge. No master secret
 * or submitted credential is persisted, logged or included in the challenge. */
export class GuestUnlock {
  private readonly pending = new Map<string, Challenge>();
  private readonly ownerHash: Buffer;
  constructor(private readonly store: ConversationStore, ownerToken: string,
    private readonly clock = () => performance.now()) {
    if (typeof ownerToken !== 'string' || !ownerToken.length) throw new GuestAccessDenied();
    this.ownerHash = createHash('sha256').update(ownerToken).digest();
  }

  begin(connectionId: string, clientId: string): string {
    if (typeof connectionId !== 'string' || !connectionId.length || connectionId.length > 128) throw new GuestAccessDenied();
    const now = this.clock();
    if (!Number.isFinite(now)) throw new GuestAccessDenied();
    for (const [id, item] of this.pending) {
      if (now < item.issuedAt || now - item.issuedAt >= 60_000) this.pending.delete(id);
    }
    if (!this.pending.has(connectionId) && this.pending.size >= 128) throw new GuestAccessDenied();
    if ([...this.pending].filter(([id, item]) => id !== connectionId && item.clientId === clientId).length >= 4) {
      throw new GuestAccessDenied();
    }
    const lock = this.store.getDeviceGuestLock(clientId);
    if (!lock) throw new GuestAccessDenied();
    const secret = randomBytes(32).toString('base64url');
    this.pending.set(connectionId, { clientId, secret, lock, issuedAt: now });
    return secret;
  }

  confirm(input: { connectionId: string; clientId: string; challenge: unknown; ownerToken: unknown; at: number }): void {
    const item = this.pending.get(input.connectionId);
    this.pending.delete(input.connectionId); // Every attempt consumes the challenge, including failure.
    const now = this.clock();
    if (!item || !Number.isFinite(now) || now < item.issuedAt || now - item.issuedAt >= 60_000
      || item.clientId !== input.clientId || input.challenge !== item.secret
      || typeof input.ownerToken !== 'string' || input.ownerToken.length > 8192
      || !timingSafeEqual(this.ownerHash, createHash('sha256').update(input.ownerToken).digest())) {
      throw new GuestAccessDenied();
    }
    this.store.releaseDeviceGuestLock({ clientId: item.clientId, expected: item.lock, at: input.at });
  }

  cancel(connectionId: string): void { this.pending.delete(connectionId); }
}
