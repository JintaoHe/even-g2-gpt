// Explicitly authorized synthetic tests. Fixed configured recipient only; never called by the model.
import 'dotenv/config';
import { mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadCalendarTransport, eventBody, CalendarError, calendarError } from '../src/google-calendar.js';
import { mailConfig, createMailSender, mailPayload } from '../src/mail.js';
import { presentation } from '../src/document-presentation.js';
import { calendarInvitation, type CalendarEvent, type CalendarInvitation } from '../src/calendar.js';

async function main() {
  if (!process.argv.includes('--send') || !process.argv.includes('--confirm-chicago-test-time')) throw Error('EXPLICIT_APPROVAL_REQUIRED');
  const config = mailConfig(process.env); if (!config) throw Error('MAIL_DISABLED');
  const recipientFlag = process.argv.indexOf('--recipient');
  if (recipientFlag < 0 || process.argv[recipientFlag + 1] !== config.to) throw Error('FIXED_RECIPIENT_CONFIRMATION_REQUIRED');
  const directory = resolve(process.env.EVEN_DATA_DIR || '.local');
  const { transport } = await loadCalendarTransport(directory);
  const info = await transport('GET', '');
  if (info.accessRole !== 'owner' || info.summary !== 'Even Assistant' || info.primary) throw Error('DEDICATED_CALENDAR_REQUIRED');
  const folder = join(directory, 'calendar-mail-smoke-v1'); await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, 'ledger.sqlite'); const db = new DatabaseSync(path); await chmod(path, 0o600);
  db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS cases (name TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const save = (name: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO cases VALUES (?, ?)').run(name, JSON.stringify(value));
  try {
    for (const [index, kind] of ['md', 'both', 'invite'].entries()) {
      const existing = db.prepare('SELECT data FROM cases WHERE name=?').get(kind) as { data: string } | undefined;
      const record = existing ? JSON.parse(existing.data) : { id: randomUUID(), eventId: randomUUID().replaceAll('-', ''), state: 'new', created: new Date().toISOString() };
      if (record.state === 'accepted') { console.log(JSON.stringify({ test: kind, result: 'already_accepted_no_resend' })); continue; }
      if (record.state === 'creating' && process.argv.includes('--reconcile-create')) {
        try { record.remote = await transport('GET', `/events/${record.eventId}`); record.state = 'created'; }
        catch (error) { if (error instanceof CalendarError && error.status === 404) record.state = 'new'; else throw error; }
        // Reuse the persisted ID. Never generate a replacement event when a result was uncertain.
        save(kind, record);
      }
      if (!['new', 'created'].includes(record.state)) throw Error('UNCERTAIN_PREVIOUS_ATTEMPT_CHECK_LEDGER');
      const title = `Even 验收 ${index + 1}—${kind === 'md' ? 'Markdown 文档' : kind === 'both' ? 'MD 与日历邀请' : '纯日历邀请'}—非真实安排`;
      const summary = kind === 'md' ? '这是你主动要求的后端邮件测试，验证 Markdown 文档、清晰标题和摘要。没有使用私人谈话或任何凭据。'
        : '这是你主动要求的正式日历邀请兼容性测试。事件已保存在助手的 Google Calendar，日期为 2026 年 10 月 1 日，芝加哥 18:00–18:15（洛杉矶 16:00–16:15，纽约 19:00–19:15）。非真实安排，不设置闹钟；是否接受由你决定。';
      const event: CalendarEvent | undefined = kind === 'md' ? undefined : { title,
        start: '2026-10-01T18:00-05:00', end: '2026-10-01T18:15-05:00', timezone: 'America/Chicago', allDay: false, location: '',
        notes: '用户主动要求的系统兼容性测试，非真实安排；不设置闹钟。测试后暂时保留，供后续修改和取消测试。' };
      const metadata = presentation(title, summary, 'summary');
      const markdown = Buffer.from(`# ${title}\n\n${summary}\n\n## 请检查\n\n- 发件人为助手专用账号。\n- 附件中文内容与标题清楚可读。\n- 如包含日历邀请，检查是否出现接受／拒绝按钮，以及显示的时区。\n\n本测试不会索要密码、付款或私人凭据。\n`);
      let invitation: CalendarInvitation | undefined;
      if (event) {
        if (record.state === 'new') {
          record.state = 'creating'; save(kind, record);
          // SMTP sends the REQUEST, so suppress native Google notifications to avoid deliberate double-send.
          // Google documents that some notifications can still occur even with sendUpdates=none.
          record.remote = await transport('POST', '/events?sendUpdates=none', { id: record.eventId, ...eventBody(event),
            attendees: [{ email: config.to, responseStatus: 'needsAction' }], reminders: { useDefault: false },
            guestsCanInviteOthers: false, guestsCanModify: false, guestsCanSeeOtherGuests: false,
            extendedProperties: { private: { evenAssistant: '1', evenSmoke: 'calendar-mail-v1' } } });
          record.state = 'created'; save(kind, record);
        }
        const remote = await transport('GET', `/events/${record.eventId}`);
        if (remote.id !== record.eventId || remote.summary !== title || remote.extendedProperties?.private?.evenSmoke !== 'calendar-mail-v1'
          || remote.status === 'cancelled' || remote.attendees?.length !== 1 || remote.attendees[0].email !== config.to
          || Date.parse(remote.start?.dateTime) !== Date.parse(event.start) || Date.parse(remote.end?.dateTime) !== Date.parse(event.end)
          || remote.reminders?.useDefault !== false || remote.reminders?.overrides?.length) throw Error('REMOTE_EVENT_MISMATCH');
        invitation = { uid: remote.iCalUID, organizer: remote.organizer?.email, attendee: config.to, sequence: remote.sequence ?? 0, stamp: remote.updated ?? remote.created };
        calendarInvitation(event, invitation); // Validate before any mail attempt.
        record.remote = remote; save(kind, record);
      }
      const sender = createMailSender(process.env, { calendarOnly: kind === 'invite', invitation }); if (!sender) throw Error('MAIL_DISABLED');
      const payload = mailPayload(record.id, markdown, metadata, event, record.created, kind === 'invite', invitation);
      record.state = 'sending'; save(kind, record);
      record.state = await sender(record.id, markdown, metadata, event, record.created); save(kind, record);
      console.log(JSON.stringify({ test: kind, result: record.state, subject: payload.subject,
        attachments: [...payload.attachments.map(a => a.filename), ...(payload.icalEvent ? [payload.icalEvent.filename] : [])], googleEventVerified: !!event }));
      if (record.state !== 'accepted') throw Error('MAIL_NOT_CONFIRMED_STOPPED');
    }
  } finally { db.close(); }
}
main().catch(error => { console.error(`SMOKE_STOPPED: ${calendarError(error)}; inspect private ledger before retry; no credentials logged.`); process.exitCode = 1; });
