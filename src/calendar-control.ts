import { GoogleCalendarService, calendarError } from './google-calendar.js';

/** Authenticated connection-owned previews: disconnect/exit invalidates unsent approvals. */
export class CalendarControl {
  private pending?: string;
  private epoch = 0;
  private busy = false;
  constructor(private service: GoogleCalendarService, private send: (event: { type: string; [key: string]: unknown }) => void) {}
  invalidate() {
    this.epoch++;
    if (this.pending) this.service.dismiss(this.pending);
    this.pending = undefined;
  }
  async handle(msg: any) {
    if (this.busy) { this.send({ type: 'calendar.error', code: 'CALENDAR_BUSY' }); return; }
    this.busy = true;
    try {
      const allowed: Record<string, string[]> = {
        'calendar.list': ['type'], 'calendar.preview': ['type', 'kind', 'event', 'eventId', 'scope'],
        'calendar.confirm': ['type', 'id', 'phrase'], 'calendar.dismiss': ['type'], 'calendar.health': ['type', 'probe']
      };
      if (!allowed[msg.type] || Object.keys(msg).some(k => !allowed[msg.type].includes(k))) throw Error('Invalid message');
      if (msg.type === 'calendar.health') {
        if (msg.probe !== undefined && typeof msg.probe !== 'boolean') throw Error('Invalid message');
        this.send({ type: 'calendar.health', health: msg.probe ? await this.service.checkHealth() : this.service.health() });
      }
      else if (msg.type === 'calendar.list') this.send({ type: 'calendar.list', ...this.service.list() });
      else if (msg.type === 'calendar.dismiss') { this.invalidate(); this.send({ type: 'calendar.dismissed' }); }
      else if (msg.type === 'calendar.preview') {
        this.invalidate(); const epoch = this.epoch;
        const result = await this.service.preview(msg.kind, msg.event, msg.eventId, undefined, true, msg.scope);
        if (epoch !== this.epoch) { this.service.dismiss(result.id); return; }
        this.pending = result.id; this.send({ type: 'calendar.preview', ...result });
      } else {
        if (!this.pending || msg.id !== this.pending || typeof msg.phrase !== 'string') {
          if (typeof msg.id !== 'string') throw Error('Invalid confirmation');
          const recovered = await this.service.reconcile(msg.id);
          if (recovered.state === 'succeeded') {
            this.send({ type: 'calendar.result', id: recovered.eventId, state: recovered.state, recovered: true });
            this.send({ type: 'calendar.list', ...this.service.list() });
            return;
          }
          if (recovered.state === 'unknown' || recovered.state === 'sending') {
            this.send({ type: 'calendar.error', code: 'CALENDAR_RECONCILIATION_REQUIRED' });
            return;
          }
          throw Error('Invalid confirmation');
        }
        const id = this.pending; this.pending = undefined;
        this.send({ type: 'calendar.working' });
        try {
          const result = await this.service.confirm(id, msg.phrase);
          this.send({ type: 'calendar.result', id: result.id, state: result.state, error: result.error });
          this.send({ type: 'calendar.list', ...this.service.list() });
        } finally { this.service.dismiss(id); }
      }
    } catch (error) { this.send({ type: 'calendar.error', code: calendarError(error) }); }
    finally { this.busy = false; }
  }
}
