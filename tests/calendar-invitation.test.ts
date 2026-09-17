import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { calendarInvitation } from '../src/calendar.js';
import { mailPayload, createMailSender } from '../src/mail.js';
import { presentation } from '../src/document-presentation.js';
const event = { title: '测试邀请', start: '2026-10-01T18:00-05:00', end: '2026-10-01T18:15-05:00', timezone: 'America/Chicago', allDay: false, location: '', notes: '仅测试' };
const invite = { uid: 'abc123@google.com', organizer: 'calendar@group.calendar.google.com', attendee: 'receiver@example.com', sequence: 0, stamp: '2026-09-16T21:00:00Z' };
test('invitation uses canonical Google UID/organizer, REQUEST, needs-action and no alarm', () => {
  const text = calendarInvitation(event, invite).content.toString().replace(/\r\n /g, '');
  for (const fragment of ['METHOD:REQUEST', 'UID:abc123@google.com', 'ORGANIZER;CN=Even Assistant:mailto:calendar@group.calendar.google.com', 'PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:receiver@example.com', 'DTSTART:20261001T230000Z']) assert.ok(text.includes(fragment));
  assert.ok(!text.includes('VALARM')); assert.ok(!text.includes('PARTSTAT=ACCEPTED'));
  assert.throws(() => calendarInvitation(event, { ...invite, organizer: 'bad\r\nINJECT:1' }));
  assert.throws(() => calendarInvitation(event, { ...invite, uid: 'bad\r\n' }));
});
test('both and invitation-only messages compile to REQUEST MIME; combined case has MD', async () => {
  for (const only of [false, true]) {
    const payload = mailPayload('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', Buffer.from('# Test'), presentation('测试', '用户请求的测试', 'summary'), event, invite.stamp, only, invite);
    assert.equal(payload.attachments.length, only ? 0 : 1);
    assert.equal(payload.icalEvent?.method, 'REQUEST');
    assert.ok(!payload.text.includes('尚未添加到日历'));
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const result = await transport.sendMail({ from: 'sender@example.com', to: invite.attendee, ...payload });
    const mime = result.message.toString();
    assert.match(mime, /text\/calendar;[^\r\n]*method=REQUEST/i);
    assert.equal(mime.includes('text/markdown'), !only);
    transport.close();
  }
});
test('invite cannot override the configured fixed recipient', () => {
  assert.throws(() => createMailSender({ EVEN_EMAIL_ENABLED: 'true', SMTP_USER: 'sender@example.com', SMTP_PASS: 'abcdefghijklmnop', EMAIL_TO: 'another@example.com' }, { invitation: invite }), /RECIPIENT_MISMATCH/);
});
