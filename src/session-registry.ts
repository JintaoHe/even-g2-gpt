import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SessionDisposeReason = 'ended' | 'expired' | 'shutdown';
export type SessionInterruptReason = 'connection_detached' | 'service_shutdown';
export type SessionDetachReason = 'connection_detached';
export type SessionEventSink<Event> = (event: Event) => void;

/** Runtime contract intentionally contains no WebSocket or platform types. */
export interface ManagedSessionRuntime<Event = unknown> {
  readonly id: string;
  replaceEventSink(sink: SessionEventSink<Event> | undefined): void;
  detach(reason: SessionDetachReason): void | Promise<void>;
  interrupt(reason: SessionInterruptReason): void | Promise<void>;
  dispose(reason: SessionDisposeReason): void | Promise<void>;
}

export type HydratedSession<Event> = {
  runtime: ManagedSessionRuntime<Event>;
  /** Time the previous process/connection last detached from this session. */
  lastDetachedAt: number;
};

export class ActiveInputLeaseError extends Error {
  readonly code = 'ACTIVE_INPUT_CLIENT_EXISTS';
  constructor() {
    super('Another input client already owns the active lease');
    this.name = 'ActiveInputLeaseError';
  }
}

export class SessionUnavailableError extends Error {
  readonly code = 'SESSION_UNAVAILABLE';
  constructor() {
    super('Conversation session is unavailable or outside the resume window');
    this.name = 'SessionUnavailableError';
  }
}

type Entry<Event> = {
  runtime: ManagedSessionRuntime<Event>;
  connectionId?: string;
  clientId?: string;
  detachedAt?: number;
};

export type SessionBinding<Event> = {
  sessionId: string;
  connectionId: string;
  runtime: ManagedSessionRuntime<Event>;
  resumed: boolean;
  replacedConnectionId?: string;
};

export type ResumeLeaseOptions = {
  clientId: string;
  allowTakeover?: boolean;
  /** Read-only scope gate, run inside the mutation queue before hydration. */
  validateAccess?: () => void;
};

export type SessionRegistryOptions<Event> = {
  resumeWindowMs: number;
  now?: () => number;
  create: (sessionId: string) => ManagedSessionRuntime<Event> | Promise<ManagedSessionRuntime<Event>>;
  hydrate?: (sessionId: string) => HydratedSession<Event> | undefined | Promise<HydratedSession<Event> | undefined>;
};

/**
 * Owns logical conversation runtimes independently from transient connections.
 * All mutations are serialized so concurrent reconnects cannot steal the single
 * active input lease or attach two event sinks to one runtime.
 */
export class SessionRegistry<Event = unknown> {
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry<Event>>();
  private readonly connections = new Map<string, string>();
  private activeInputConnection?: string;
  private mutationQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: SessionRegistryOptions<Event>) {
    if (!Number.isSafeInteger(options.resumeWindowMs) || options.resumeWindowMs < 1_000) {
      throw new Error('Resume window must be at least one second');
    }
    this.now = options.now ?? Date.now;
  }

  create(connectionId: string, sink: SessionEventSink<Event>, sessionId = randomUUID(),
    authorize?: () => void | Promise<void>, clientId?: string): Promise<SessionBinding<Event>> {
    return this.serial(async () => {
      this.ensureOpen();
      this.validateIds(connectionId, sessionId);
      this.ensureLeaseAvailable(connectionId);
      if (this.entries.has(sessionId)) throw new SessionUnavailableError();
      await authorize?.();
      const runtime = await this.options.create(sessionId);
      if (runtime.id !== sessionId) {
        await runtime.dispose('shutdown');
        throw new Error('Session runtime id does not match requested session');
      }
      const entry: Entry<Event> = { runtime };
      this.entries.set(sessionId, entry);
      this.attach(entry, sessionId, connectionId, sink, clientId);
      return { sessionId, connectionId, runtime, resumed: false };
    });
  }

  resume(sessionId: string, connectionId: string, sink: SessionEventSink<Event>,
    authorize?: () => void | Promise<void>, lease: ResumeLeaseOptions | undefined = undefined): Promise<SessionBinding<Event>> {
    return this.serial(async () => {
      this.ensureOpen();
      this.validateIds(connectionId, sessionId);
      lease?.validateAccess?.();
      let entry = this.entries.get(sessionId);
      if (!entry) {
        const hydrated = await this.options.hydrate?.(sessionId);
        if (!hydrated || hydrated.runtime.id !== sessionId || !Number.isSafeInteger(hydrated.lastDetachedAt)) {
          throw new SessionUnavailableError();
        }
        entry = { runtime: hydrated.runtime, detachedAt: hydrated.lastDetachedAt };
        if (this.isExpired(entry)) {
          await entry.runtime.dispose('expired');
          throw new SessionUnavailableError();
        }
        this.entries.set(sessionId, entry);
      }
      const replacedConnectionId = entry.connectionId && entry.connectionId !== connectionId
        ? entry.connectionId : undefined;
      if (replacedConnectionId) {
        if (!lease?.allowTakeover || !lease.clientId || entry.clientId !== lease.clientId
          || this.activeInputConnection !== replacedConnectionId) throw new ActiveInputLeaseError();
        // Validate the scoped credential before changing the active lease. The
        // caller's authorization callback also binds the proof to clientId and
        // sessionId, so merely claiming the same public client ID is useless.
        await authorize?.();
        this.connections.delete(replacedConnectionId);
        if (this.activeInputConnection === replacedConnectionId) this.activeInputConnection = undefined;
        entry.connectionId = undefined;
        entry.detachedAt = this.now();
        entry.runtime.replaceEventSink(undefined);
        await entry.runtime.detach('connection_detached');
      } else {
        this.ensureLeaseAvailable(connectionId);
        if (entry.detachedAt === undefined || this.isExpired(entry)) {
          if (entry.detachedAt !== undefined) await this.expireEntry(sessionId, entry);
          throw new SessionUnavailableError();
        }
        await authorize?.();
      }
      this.attach(entry, sessionId, connectionId, sink, lease?.clientId ?? entry.clientId);
      return { sessionId, connectionId, runtime: entry.runtime, resumed: true,
        ...(replacedConnectionId ? { replacedConnectionId } : {}) };
    });
  }

  detach(connectionId: string): Promise<string | undefined> {
    return this.serial(async () => {
      const sessionId = this.connections.get(connectionId);
      if (!sessionId) return undefined;
      const entry = this.entries.get(sessionId);
      this.connections.delete(connectionId);
      if (this.activeInputConnection === connectionId) this.activeInputConnection = undefined;
      if (!entry || entry.connectionId !== connectionId) return sessionId;
      entry.connectionId = undefined;
      entry.detachedAt = this.now();
      entry.runtime.replaceEventSink(undefined);
      await entry.runtime.detach('connection_detached');
      return sessionId;
    });
  }

  /** A verified device may attach only the guest session selected by its durable
   * lock. Selection and final validation run under the single input lease queue. */
  attachGuest(connectionId: string, clientId: string, sink: SessionEventSink<Event>,
    select: () => string, validate: () => void): Promise<SessionBinding<Event>> {
    return this.serial(async () => {
      this.ensureOpen();
      const sessionId = select(); this.validateIds(connectionId, sessionId);
      let entry = this.entries.get(sessionId);
      const replacedConnectionId = entry?.connectionId;
      if (replacedConnectionId && replacedConnectionId !== connectionId) {
        if (entry!.clientId !== clientId || this.activeInputConnection !== replacedConnectionId) throw new ActiveInputLeaseError();
        validate();
        this.connections.delete(replacedConnectionId);
        this.activeInputConnection = undefined;
        entry!.connectionId = undefined;
        entry!.detachedAt = this.now();
        entry!.runtime.replaceEventSink(undefined);
        await entry!.runtime.detach('connection_detached');
      } else this.ensureLeaseAvailable(connectionId);
      if (entry && this.isExpired(entry)) { await this.expireEntry(sessionId, entry); entry = undefined; }
      // Expiry may have terminalized the old guest session. Selection rebinds it.
      const selectedId = select();
      this.validateIds(connectionId, selectedId);
      entry = this.entries.get(selectedId);
      const resumed = !!entry;
      if (!entry) {
        const runtime = await this.options.create(selectedId);
        entry = { runtime }; this.entries.set(selectedId, entry);
      }
      try { validate(); }
      catch (error) {
        if (!resumed) { this.entries.delete(selectedId); await entry.runtime.dispose('shutdown'); }
        throw error;
      }
      this.attach(entry, selectedId, connectionId, sink, clientId);
      return { sessionId: selectedId, connectionId, runtime: entry.runtime, resumed, replacedConnectionId };
    });
  }

  end(sessionId: string): Promise<boolean> {
    return this.serial(async () => {
      const entry = this.entries.get(sessionId);
      if (!entry) return false;
      if (entry.connectionId) {
        this.connections.delete(entry.connectionId);
        if (this.activeInputConnection === entry.connectionId) this.activeInputConnection = undefined;
        entry.runtime.replaceEventSink(undefined);
      }
      this.entries.delete(sessionId);
      await entry.runtime.dispose('ended');
      return true;
    });
  }

  sweepExpired(): Promise<string[]> {
    return this.serial(async () => {
      const expired: string[] = [];
      for (const [sessionId, entry] of this.entries) {
        if (entry.connectionId || entry.detachedAt === undefined || !this.isExpired(entry)) continue;
        await this.expireEntry(sessionId, entry);
        expired.push(sessionId);
      }
      return expired;
    });
  }

  /** Development/test hook. Production transports must never expose it. */
  expireDetached(sessionId: string): Promise<boolean> {
    return this.serial(async () => {
      const entry = this.entries.get(sessionId);
      if (!entry) return false;
      if (entry.connectionId || entry.detachedAt === undefined) throw new Error('Session must detach before forced expiry');
      await this.expireEntry(sessionId, entry);
      return true;
    });
  }

  connectionFor(sessionId: string) { return this.entries.get(sessionId)?.connectionId; }

  has(sessionId: string) { return this.entries.has(sessionId); }

  shutdown(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      for (const entry of this.entries.values()) {
        if (entry.connectionId) entry.runtime.replaceEventSink(undefined);
        await entry.runtime.interrupt('service_shutdown');
        await entry.runtime.dispose('shutdown');
      }
      this.entries.clear();
      this.connections.clear();
      this.activeInputConnection = undefined;
    });
  }

  private attach(entry: Entry<Event>, sessionId: string, connectionId: string, sink: SessionEventSink<Event>, clientId?: string) {
    entry.connectionId = connectionId;
    if (clientId) entry.clientId = clientId;
    entry.detachedAt = undefined;
    this.connections.set(connectionId, sessionId);
    this.activeInputConnection = connectionId;
    entry.runtime.replaceEventSink(sink);
  }

  private async expireEntry(sessionId: string, entry: Entry<Event>) {
    this.entries.delete(sessionId);
    await entry.runtime.dispose('expired');
  }

  private isExpired(entry: Entry<Event>) {
    return entry.detachedAt !== undefined && this.now() - entry.detachedAt >= this.options.resumeWindowMs;
  }

  private ensureLeaseAvailable(connectionId: string) {
    if (this.activeInputConnection && this.activeInputConnection !== connectionId) throw new ActiveInputLeaseError();
  }

  private validateIds(connectionId: string, sessionId: string) {
    if (!UUID.test(connectionId) || !UUID.test(sessionId)) throw new Error('Invalid connection or session id');
  }

  private ensureOpen() {
    if (this.closed) throw new Error('Session registry is closed');
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.mutationQueue.then(work, work);
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
