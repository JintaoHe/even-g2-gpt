import { validateCalendar, type CalendarEvent } from './calendar.js';
import type { CalendarScope } from './google-calendar.js';

export type RecoveryPersistence<T extends object> = {
  save(value: T): void;
  clear(): void;
};

export type DeliveryRecoveryState = {
  version: 1;
  jobId: string;
};

export type CalendarRecoveryTarget = { id: string; title: string };

export type CalendarRecoveryState = {
  version: 1;
  draft: {
    kind: 'create' | 'update' | 'cancel';
    event: CalendarEvent;
    before?: CalendarEvent;
    eventId?: string;
    scope?: CalendarScope;
    blocked?: boolean;
    operationId?: string;
  };
  batch?: { events: CalendarEvent[]; index: number };
  cancelBatch?: { items: CalendarRecoveryTarget[]; retainedTitles: string[]; index: number };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeProviderId = (value: unknown) => typeof value === 'string' && value.length >= 5 && value.length <= 1024
  && !/[\x00-\x1f\x7f]/.test(value);

export function parseDeliveryRecoveryState(value: unknown): DeliveryRecoveryState | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.jobId !== 'string' || !UUID.test(input.jobId)
    || Object.keys(input).some(key => !['version', 'jobId'].includes(key))) return undefined;
  return { version: 1, jobId: input.jobId };
}

export function parseCalendarRecoveryState(value: unknown): CalendarRecoveryState | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
  const input = value as Record<string, any>;
  if (input.version !== 1 || !input.draft || Array.isArray(input.draft) || typeof input.draft !== 'object'
    || Object.keys(input).some(key => !['version', 'draft', 'batch', 'cancelBatch'].includes(key))) return undefined;
  const source = input.draft as Record<string, any>;
  if (!['create', 'update', 'cancel'].includes(source.kind)
    || Object.keys(source).some(key => !['kind', 'event', 'before', 'eventId', 'scope', 'blocked', 'operationId'].includes(key))
    || (source.scope !== undefined && !['single', 'series'].includes(source.scope))
    || (source.blocked !== undefined && typeof source.blocked !== 'boolean')
    || (source.operationId !== undefined && (typeof source.operationId !== 'string' || !UUID.test(source.operationId)))
    || (source.kind !== 'create' && !safeProviderId(source.eventId))
    || (source.kind === 'create' && source.eventId !== undefined)) return undefined;
  let event: CalendarEvent, before: CalendarEvent | undefined;
  try {
    event = validateCalendar(source.event);
    before = source.before === undefined ? undefined : validateCalendar(source.before);
  } catch { return undefined; }
  if (source.kind !== 'create' && !before) return undefined;

  let batch: CalendarRecoveryState['batch'];
  if (input.batch !== undefined) {
    if (!input.batch || Array.isArray(input.batch) || typeof input.batch !== 'object'
      || !Array.isArray(input.batch.events) || input.batch.events.length < 1 || input.batch.events.length > 20
      || !Number.isSafeInteger(input.batch.index) || input.batch.index < 0 || input.batch.index >= input.batch.events.length
      || Object.keys(input.batch).some(key => !['events', 'index'].includes(key))) return undefined;
    try { batch = { events: input.batch.events.map(validateCalendar), index: input.batch.index }; }
    catch { return undefined; }
  }

  let cancelBatch: CalendarRecoveryState['cancelBatch'];
  if (input.cancelBatch !== undefined) {
    const value = input.cancelBatch;
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || !Array.isArray(value.items) || value.items.length < 2 || value.items.length > 20
      || !Array.isArray(value.retainedTitles) || value.retainedTitles.length > 20
      || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= value.items.length
      || Object.keys(value).some(key => !['items', 'retainedTitles', 'index'].includes(key))) return undefined;
    const items = value.items.map((item: any) => item && !Array.isArray(item) && typeof item === 'object'
      && Object.keys(item).every(key => ['id', 'title'].includes(key)) && safeProviderId(item.id)
      && typeof item.title === 'string' && item.title.trim() && item.title.length <= 200
      ? { id: item.id, title: item.title.trim() } : undefined);
    if (items.some((item: CalendarRecoveryTarget | undefined) => !item)
      || value.retainedTitles.some((title: unknown) => typeof title !== 'string' || !String(title).trim() || String(title).length > 200)) return undefined;
    cancelBatch = { items: items as CalendarRecoveryTarget[], retainedTitles: value.retainedTitles.map((title: string) => title.trim()), index: value.index };
  }
  if ((batch && source.kind !== 'create') || (cancelBatch && source.kind !== 'cancel') || (batch && cancelBatch)) return undefined;
  return { version: 1, draft: { kind: source.kind, event, ...(before ? { before } : {}),
    ...(source.eventId ? { eventId: source.eventId } : {}), ...(source.scope ? { scope: source.scope } : {}),
    ...(source.blocked ? { blocked: true } : {}), ...(source.operationId ? { operationId: source.operationId } : {}) },
    ...(batch ? { batch } : {}), ...(cancelBatch ? { cancelBatch } : {}) };
}
