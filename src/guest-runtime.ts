import { randomUUID } from 'node:crypto';
import type { ConversationStore } from './conversation-store.js';
import { ContextBuilder } from './context-builder.js';
import type { DialogueModel, Event, Message } from './conversation.js';
import type { DraftGenerator } from './delivery-draft.js';
import { createDraftGenerator } from './delivery-draft.js';
import { GuestDraftRuntime } from './guest-draft-runtime.js';
import { GuestDialogue } from './guest-dialogue.js';
import { lockedDevicePrincipal, requireGuestAccess, type AccessPrincipal } from './guest-access.js';
import { createHybridDialogue } from './hybrid-dialogue.js';
import { LocationDialogue } from './location-dialogue.js';
import { LocationRequestBroker, parseLocationReport } from './location.js';
import type { RouteProvider } from './routes.js';

type GuestPrincipal = Extract<AccessPrincipal, { mode: 'guest' }>;
type Dependencies = { model: DialogueModel; generate: DraftGenerator; routes?: RouteProvider };
type Factory = (guard: () => void, signal: AbortSignal) => Dependencies;

/** Internal, authenticated-only assembly. No hello/voice entry is enabled yet. */
export class GuestRuntime {
  readonly model: DialogueModel;
  private readonly drafts: GuestDraftRuntime;
  private readonly location: LocationRequestBroker;
  private readonly base: DialogueModel;
  private readonly located?: LocationDialogue;
  private readonly principal: GuestPrincipal;
  private readonly epoch: number;
  private readonly lifetime = new AbortController();
  private readonly signals = new WeakMap<AbortSignal, AbortSignal>();
  private sink?: (event: Event) => void;
  private closed = false;
  private started = false;
  private replying = false;

  constructor(private store: ConversationStore, readonly clientId: string, principal: AccessPrincipal, factory: Factory) {
    requireGuestAccess(principal, 'conversation');
    if (principal.mode !== 'guest') throw new Error('GUEST_ACCESS_DENIED');
    this.principal = Object.freeze({ ...principal });
    this.epoch = store.getDeviceAccessEpoch(clientId);
    this.assertAccess();
    const dependencies = factory(() => this.assertAccess(), this.lifetime.signal);
    this.base = dependencies.model;
    this.drafts = new GuestDraftRuntime(store, clientId, this.principal, dependencies.generate);
    this.location = new LocationRequestBroker(event => { if (!this.closed) { this.assertAccess(); this.sink?.(event); } }, randomUUID);
    const routes = dependencies.routes;
    const checkedRoutes: RouteProvider | undefined = routes && {
      route: async (...args) => { this.assertAccess(); const result = await routes.route(...args); this.assertAccess(); return result; },
      ...(routes.discover ? { discover: async (...args: Parameters<NonNullable<RouteProvider['discover']>>) => {
        this.assertAccess(); const result = await routes.discover!(...args); this.assertAccess(); return result;
      } } : {}),
    };
    this.located = checkedRoutes ? new LocationDialogue(this.base, this.location, checkedRoutes,
      'UTC', Date.now, this.base) : undefined;
    // The deny/draft gate wraps location, so a pending address clarification
    // cannot turn a private operation back into a Maps action.
    const inner = new GuestDialogue(this.located ?? this.base, this.drafts);
    this.model = {
      startSession: () => { this.assertAccess(); if (!this.started) {
        this.started = true; this.base.startSession?.(); this.located?.startSession();
      } },
      endSession: () => this.close(),
      plan: async (_history, text, forced, inputSignal) => {
        const signal = this.signal(inputSignal);
        const plan = await inner.plan!(this.history(), text, forced, signal);
        this.assertAccess(); signal.throwIfAborted(); return plan;
      },
      decide: async (history, text, forced, signal) => (await this.model.plan!(history, text, forced, signal)).decision,
      reply: async (_history, inputSignal, delta, update, effort, mode, workflows) => {
        const signal = this.signal(inputSignal);
        if (this.replying) throw new Error('GUEST_RUNTIME_BUSY');
        this.replying = true;
        try { await inner.reply(this.history(), signal,
          text => { this.assertAccess(); signal.throwIfAborted(); delta(text); },
          event => { this.assertAccess(); signal.throwIfAborted(); update?.(event); }, effort, mode, workflows);
        this.assertAccess(); signal.throwIfAborted();
        } finally { this.replying = false; }
      },
    };
  }

  assertAccess() {
    if (this.closed) throw new Error('GUEST_ACCESS_DENIED');
    const current = lockedDevicePrincipal(this.store.getDeviceGuestLock(this.clientId), 'single-user');
    const session = this.store.getSession(this.principal.sessionId);
    if (current.mode !== 'guest' || current.sessionId !== this.principal.sessionId
      || current.ownerScope !== this.principal.ownerScope || this.store.getDeviceAccessEpoch(this.clientId) !== this.epoch
      || !session || !['active', 'idle'].includes(session.status)) throw new Error('GUEST_ACCESS_DENIED');
    requireGuestAccess(this.principal, 'conversation', { ownerScope: session.ownerScope, sessionId: session.id });
  }
  matches(clientId: string, principal: GuestPrincipal) {
    return clientId === this.clientId && principal.sessionId === this.principal.sessionId && principal.ownerScope === this.principal.ownerScope;
  }
  private signal(input: AbortSignal) {
    this.assertAccess(); input.throwIfAborted();
    let signal = this.signals.get(input);
    if (!signal) { signal = AbortSignal.any([input, this.lifetime.signal]); this.signals.set(input, signal); }
    signal.throwIfAborted(); return signal;
  }
  private history(): Message[] {
    this.assertAccess();
    return new ContextBuilder().build({
      messages: this.store.listRecentMessages(this.principal.sessionId, 100)
        .filter(m => m.role !== 'system' && m.status !== 'streaming')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, topicId: m.topicId,
          sequence: m.sequence, status: m.status })),
      summary: this.store.latestSummary(this.principal.sessionId),
    }).messages;
  }
  setSink(sink?: (event: Event) => void) { this.assertAccess(); this.sink = sink; }
  transportLocationBroker() { this.assertAccess(); return this.location; }
  transportLocationDialogue() { this.assertAccess(); return this.located; }
  acceptLocation(report: unknown) {
    this.assertAccess(); const parsed = parseLocationReport(report);
    return parsed.requestId ? this.location.accept(parsed) : this.location.prime(parsed);
  }
  failLocation(report: unknown) { this.assertAccess(); return this.location.fail(report); }
  setLocationAvailable(value: boolean) { this.assertAccess(); this.location.setClientLocationAvailable(value); }
  readDraft(id?: string) { this.assertAccess(); return this.drafts.read(id); }
  close() {
    if (this.closed) return;
    this.closed = true; this.sink = undefined;
    this.lifetime.abort(); this.location?.cancel(); this.location?.clear();
    this.located?.endSession(); this.base?.endSession?.();
  }
}

/** One pool per server: reconnects reuse one runtime, draft single-flight and
 * search quota. Caller must release on terminal sessions and close on shutdown. */
export class GuestRuntimePool {
  private entries = new Map<string, GuestRuntime>();
  private closed = false;
  constructor(private store: ConversationStore, private factory: Factory) {}
  get size() { return this.entries.size; }
  /** Read failures also evict: never retain a runtime whose access is uncertain. */
  sweepInvalid(): number {
    let removed = 0;
    let failure: unknown;
    for (const [id, runtime] of this.entries) {
      try { runtime.assertAccess(); } catch {
        try { this.release(id); } catch (error) { failure ??= error; }
        removed++;
      }
    }
    if (failure) throw failure;
    return removed;
  }
  acquireAuthenticated(clientId: string, principal: AccessPrincipal) {
    if (this.closed) throw new Error('GUEST_ACCESS_DENIED');
    requireGuestAccess(principal, 'conversation');
    if (principal.mode !== 'guest') throw new Error('GUEST_ACCESS_DENIED');
    this.sweepInvalid();
    const existing = this.entries.get(principal.sessionId);
    if (existing) {
      if (!existing.matches(clientId, principal)) throw new Error('GUEST_ACCESS_DENIED');
      existing.assertAccess(); return existing;
    }
    const runtime = new GuestRuntime(this.store, clientId, principal, this.factory);
    this.entries.set(principal.sessionId, runtime); return runtime;
  }
  release(sessionId: string) { const runtime = this.entries.get(sessionId); this.entries.delete(sessionId); runtime?.close(); }
  releaseClient(clientId: string) {
    let failure: unknown;
    for (const [id, runtime] of this.entries) if (runtime.clientId === clientId) {
      try { this.release(id); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  close() {
    this.closed = true;
    let failure: unknown;
    for (const id of this.entries.keys()) try { this.release(id); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
}

/** Must receive the server's metered fetch. Never consult DIALOGUE_PROVIDER or
 * construct a CLI runner, even when the owner is using CLI. */
export function createGuestRuntimePool(store: ConversationStore, env: NodeJS.ProcessEnv,
  meteredFetch: typeof fetch, routes?: RouteProvider): GuestRuntimePool {
  if (!env.OPENAI_API_KEY || typeof meteredFetch !== 'function') throw new Error('GUEST_API_REQUIRED');
  const guestEnv = { ...env, DIALOGUE_PROVIDER: 'api', GOOGLE_CALENDAR_ENABLED: 'false', EVEN_EMAIL_ENABLED: 'false',
    GOOGLE_ENVIRONMENT_ENABLED: 'false', EVEN_DELIVERY_ROUTING: 'true', GOOGLE_MAPS_ENABLED: routes ? 'true' : 'false' };
  return new GuestRuntimePool(store, (guard, lifetime) => {
    const fetcher: typeof fetch = async (input, init) => {
      guard();
      const response = await meteredFetch(input, { ...init, signal: AbortSignal.any([lifetime, ...(init?.signal ? [init.signal] : [])]) });
      try { guard(); return response; } catch (error) { await response.body?.cancel(); throw error; }
    };
    const { model } = createHybridDialogue(env.OPENAI_API_KEY!, guestEnv, { fetcher,
      extraInstructions: 'You are in guest mode. Only this guest session is available. You may chat, search public information, help with routes, and prepare private drafts for this session. You cannot access owner history, personal memory, calendars, email, global files or CLI. Never claim a mode change, owner authorization, email delivery or private operation succeeded. Drafts stay in this guest session; do not offer to email or download them. No cross-session recall is available.' });
    return { model, generate: createDraftGenerator(guestEnv, fetcher), routes };
  });
}
