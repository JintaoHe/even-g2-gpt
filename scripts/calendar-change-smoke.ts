// Explicitly approved, two-stage real mail/calendar test. Never called by the model.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadCalendarTransport, GoogleCalendarService, eventBody } from '../src/google-calendar.js';
import { createMailSender, mailConfig } from '../src/mail.js';
import { calendarInvitation, type CalendarEvent } from '../src/calendar.js';
import { presentation } from '../src/document-presentation.js';

const title = 'Even 联动测试—非真实安排';
const initial: CalendarEvent = { title, start: '2026-10-01T18:00-05:00', end: '2026-10-01T18:15-05:00', timezone: 'America/Chicago', allDay: false, location: '测试会议室A', notes: 'UI流程检查；非真实安排。' };
const changed: CalendarEvent = { ...initial, start: '2026-10-02T19:00-05:00', end: '2026-10-02T19:30-05:00', location: '测试会议室B', notes: 'UI与代码审查；非真实安排。' };
let phase = 'setup';
async function main() {
  const stage = process.argv[process.argv.indexOf('--stage') + 1];
  if (!['initial', 'update'].includes(stage) || !process.argv.includes('--approved-chicago-times')) throw Error('EXPLICIT_APPROVAL_REQUIRED');
  if (stage === 'update' && !process.argv.includes('--initial-received')) throw Error('RECEIPT_REQUIRED');
  const config = mailConfig(process.env); if (!config) throw Error('MAIL_DISABLED');
  if (process.argv[process.argv.indexOf('--recipient') + 1] !== config.to) throw Error('FIXED_RECIPIENT_REQUIRED');
  const root = resolve(process.env.EVEN_DATA_DIR || '.local'), dir = join(root, 'calendar-change-smoke-v1');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dbPath = join(dir, 'ledger.sqlite'), db = new DatabaseSync(dbPath); await chmod(dbPath, 0o600);
  db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS steps (name TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const get = (name: string) => { const row = db.prepare('SELECT data FROM steps WHERE name=?').get(name) as { data: string } | undefined; return row ? JSON.parse(row.data) : undefined; };
  const save = (name: string, data: unknown) => db.prepare('INSERT OR REPLACE INTO steps VALUES (?, ?)').run(name, JSON.stringify(data));
  async function step(name: string, fn: () => Promise<unknown>) {
    phase = name; const previous = get(name);
    if (previous?.state === 'done') { console.log(`SKIP ${name}: already completed`); return previous.result; }
    if (previous) throw Error('UNCERTAIN_PREVIOUS_STEP');
    save(name, { state: 'started', at: new Date().toISOString() });
    const result = await fn(); save(name, { state: 'done', result }); console.log(`PASS ${name}`); return result;
  }
  let service: GoogleCalendarService | undefined;
  try {
    const { transport, calendarId } = await loadCalendarTransport(root);
    const info = await transport('GET', '');
    assert.ok(info.accessRole === 'owner' && info.summary === 'Even Assistant' && !info.primary);
    if (!get('identity')) save('identity', { eventId: randomUUID().replaceAll('-', ''), invitationMail: randomUUID(), updateMail: randomUUID(), created: new Date().toISOString() });
    const identity = get('identity');
    const verify = (remote: any, event: CalendarEvent) => {
      assert.equal(remote.id, identity.eventId); assert.equal(remote.summary, title);
      assert.equal(remote.extendedProperties?.private?.evenSmoke, 'calendar-change-v1');
      assert.equal(remote.attendees?.length, 1); assert.equal(remote.attendees[0].email, config.to);
      assert.equal(Date.parse(remote.start?.dateTime), Date.parse(event.start)); assert.equal(Date.parse(remote.end?.dateTime), Date.parse(event.end));
      assert.equal(remote.location, event.location); assert.equal(remote.description, event.notes);
      assert.equal(remote.reminders?.useDefault, false); assert.ok(!remote.reminders?.overrides?.length);
      assert.notEqual(remote.status, 'cancelled');
    };
    if (stage === 'initial') {
      await step('create', async () => {
        const remote = await transport('POST', '/events?sendUpdates=none', { id: identity.eventId, ...eventBody(initial), attendees: [{ email: config.to, responseStatus: 'needsAction' }],
          reminders: { useDefault: false }, guestsCanInviteOthers: false, guestsCanModify: false, guestsCanSeeOtherGuests: false,
          extendedProperties: { private: { evenAssistant: '1', evenSmoke: 'calendar-change-v1' } } });
        verify(remote, initial); return { uid: remote.iCalUID, sequence: remote.sequence ?? 0 };
      });
      await step('initial_mail', async () => {
        const remote = await transport('GET', `/events/${identity.eventId}`); verify(remote, initial);
        const invitation = { uid: remote.iCalUID, organizer: remote.organizer.email, attendee: config.to, sequence: remote.sequence ?? 0, stamp: remote.updated ?? remote.created };
        calendarInvitation(initial, invitation);
        const summary = '这是你主动要求的会议变更联动测试。初始安排为2026年10月1日芝加哥18:00–18:15，测试会议室A，议程为UI流程检查。请先接受邀请；确认收到后再进行改期。非真实安排，无闹钟。';
        const md = Buffer.from(`# ${title}：初始议程\n\n${summary}\n\n## 议程\n\n- 检查UI流程。\n- 验证收到邀请并接受。\n- 后续将更新同一个会议，不创建第二场会议。\n`);
        const sender = createMailSender(process.env, { invitation })!;
        const result = await sender(identity.invitationMail, md, presentation('Even联动测试—初始邀请与议程', summary, 'summary'), initial, identity.created);
        assert.equal(result, 'accepted'); return { smtp: result, attachments: ['md', 'ics'] };
      });
      console.log('WAIT recipient receipt/acceptance before update stage. No update sent.');
    } else {
      assert.equal(get('initial_mail')?.state, 'done');
      service = await GoogleCalendarService.create(join(dir, 'service'), calendarId, transport, Date.now, config.to);
      await step('update_original', async () => {
        const before = await transport('GET', `/events/${identity.eventId}`); verify(before, initial);
        const preview = await service!.preview('update', changed, identity.eventId, initial, true);
        const result = await service!.confirm(preview.id, preview.phrase);
        assert.equal(result.state, 'succeeded'); assert.equal(result.notifyGuests, true);
        const after = await transport('GET', `/events/${identity.eventId}`); verify(after, changed);
        assert.equal(after.iCalUID, get('create').result.uid); assert.ok(after.sequence > get('create').result.sequence);
        return { sameEventId: true, sameICalUID: true, sequenceIncreased: true, googleSaved: true, guestNotificationsRequested: true };
      });
      await step('updated_md_mail', async () => {
        const remote = await transport('GET', `/events/${identity.eventId}`); verify(remote, changed);
        const summary = 'Google已保存原会议的变更：10月1日18:00–18:15改为10月2日19:00–19:30（均为2026年芝加哥时间）；测试会议室A改为B；议程增加代码审查。此邮件附新版MD，日历更新由Google单独通知。非真实安排。';
        const md = Buffer.from(`# ${title}：更新后的议程\n\n${summary}\n\n| 项目 | 原安排 | 新安排 |\n|---|---|---|\n| 日期 | 2026-10-01 | 2026-10-02 |\n| 芝加哥时间 | 18:00–18:15 | 19:00–19:30 |\n| 地点 | 测试会议室A | 测试会议室B |\n| 议程 | UI流程检查 | UI流程与代码审查 |\n\n同一个Google事件与iCalendar UID，未新建第二场会议。旧MD附件不会自动改写，请以本文件为准。请检查你的日历是否已更新；如Google提示重新接受，请自行确认。\n`);
        const result = await createMailSender(process.env)!(identity.updateMail, md, presentation('Even联动测试—会议变更与新版议程', summary, 'summary'));
        assert.equal(result, 'accepted'); return { smtp: result, attachments: ['md'] };
      });
      console.log('PASS update workflow complete; recipient calendar sync still needs user verification.');
    }
  } finally { await service?.close(); db.close(); }
}
main().catch(() => { console.error(`CHANGE_SMOKE_STOPPED phase=${phase}; inspect private ledger before retry; no automatic resend.`); process.exitCode = 1; });
