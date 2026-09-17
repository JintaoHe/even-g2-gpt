import nodemailer from 'nodemailer';
import { connect as connectTls } from 'node:tls';
import { connect as connectTcp, type Socket } from 'node:net';
import { mailPresentation, type Presentation } from './document-presentation.js';
import { calendarAttachment, calendarDetails, calendarInvitation, type CalendarInvitation, type CalendarEvent } from './calendar.js';

export type MailResult = 'accepted' | 'failed' | 'unknown';
export type MailSender = (id: string, markdown: Buffer, metadata?: Presentation, calendar?: CalendarEvent, created?: string, deliveryId?: string) => Promise<MailResult>;
export function mailPayload(id: string, markdown: Buffer, metadata?: Presentation, calendar?: CalendarEvent, created?: string, calendarOnly = false, invitation?: CalendarInvitation) {
  if (calendarOnly && !calendar) throw new Error('CALENDAR_REQUIRED');
  if (invitation && !calendar) throw new Error('CALENDAR_REQUIRED');
  const filename = mailPresentation(metadata).filename;
  const attachment = calendar && !invitation ? calendarAttachment(id, calendar, created ?? '') : undefined;
  const icalEvent = invitation && calendar ? calendarInvitation(calendar, invitation) : undefined;
  const attachments = [...(calendarOnly ? [] : [{ filename, content: markdown, contentType: 'text/markdown; charset=utf-8' }]), ...(attachment ? [attachment] : [])];
  const content = mailPresentation(metadata, [...attachments.map(item => item.filename), ...(icalEvent ? [icalEvent.filename] : [])]);
  const details = calendar ? invitation
    ? `\n\n正式日历邀请（Google 上的原事件已创建）\n${calendarDetails(calendar).replace('尚未添加到日历；请打开 ICS 附件确认导入。重复导入可能产生重复事件。', '请使用邮件客户端的接受／拒绝功能。客户端识别及回复同步需本次测试验证；不要反复导入附件。')}`
    : `\n\n日程附件（需你确认添加）\n${calendarDetails(calendar)}` : '';
  const escaped = details.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  return { subject: content.subject, text: content.text + details, html: content.html + (details ? `<pre style="white-space:pre-wrap">${escaped}</pre>` : ''),
    attachments, ...(icalEvent ? { icalEvent } : {}) };
}
type Config = { user: string; password: string; to: string; port: 465 | 587 };
export function mailConfig(env: NodeJS.ProcessEnv): Config | undefined {
  if (env.EVEN_EMAIL_ENABLED !== 'true') return undefined;
  const user = env.SMTP_USER?.trim() ?? '', to = env.EMAIL_TO?.trim() ?? '';
  const password = (env.SMTP_PASS ?? '').replace(/ /g, '');
  const port = env.SMTP_PORT === '587' ? 587 : 465;
  const address = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;
  if (!address.test(user) || !address.test(to) || user.length > 254 || to.length > 254
    || !/^[a-z]{16}$/i.test(password) || (env.EMAIL_FROM && env.EMAIL_FROM !== user)
    || (env.SMTP_HOST && env.SMTP_HOST !== 'smtp.gmail.com')
    || (env.SMTP_PORT && !['465', '587'].includes(env.SMTP_PORT))
    || (env.SMTP_SECURE && env.SMTP_SECURE !== (port === 465 ? 'true' : 'false'))) {
    throw new Error('MAIL_CONFIG_INVALID'); // Never include configuration values.
  }
  return { user, password, to, port };
}

export function createMailSender(env: NodeJS.ProcessEnv = process.env, options: { calendarOnly?: boolean; invitation?: CalendarInvitation } = {}): MailSender | undefined {
  const config = mailConfig(env);
  if (!config) return undefined;
  if (options.invitation && options.invitation.attendee !== config.to) throw new Error('INVITATION_RECIPIENT_MISMATCH');
  return async (id, markdown, metadata, calendar, created, deliveryId = id) => {
    if (!/^[a-f0-9-]{36}$/.test(deliveryId)) return 'failed';
    if (!/^[a-f0-9-]{36}$/.test(id) || !markdown.length || markdown.length > 2 * 1024 * 1024) return 'failed';
    let payload: ReturnType<typeof mailPayload>;
    try { payload = mailPayload(id, markdown, metadata, calendar, created, options.calendarOnly, options.invitation); } catch { return 'failed'; }
    // Own the socket so the overall deadline can destroy it, including during DATA.
    // A non-pooled transport makes exactly one attempt (no pool requeue behavior).
    let socket: Socket | undefined;
    let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const attempt = async (): Promise<MailResult> => {
      socket = config.port === 465 ? connectTls({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com',
        minVersion: 'TLSv1.2', rejectUnauthorized: true }) : connectTcp({ host: 'smtp.gmail.com', port: 587 });
      await new Promise<void>((resolve, reject) => {
        socket!.once(config.port === 465 ? 'secureConnect' : 'connect', resolve); socket!.once('error', reject);
      });
      transport = nodemailer.createTransport({
      connection: socket, secured: config.port === 465,
      host: 'smtp.gmail.com', port: config.port, secure: config.port === 465, requireTLS: true,
      auth: { user: config.user, pass: config.password },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.gmail.com' },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000, dnsTimeout: 10000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true
    });
      const info = await transport.sendMail({
        from: { name: 'Even Assistant · 系统通知', address: config.user }, to: config.to,
        envelope: { from: config.user, to: [config.to] },
        messageId: `<even-${deliveryId}@${config.user.split('@')[1]}>`,
        ...payload,
        disableFileAccess: true, disableUrlAccess: true
      });
      return info.accepted?.length === 1 && info.rejected?.length === 0 ? 'accepted' : 'failed';
    };
    try {
      const result = attempt().catch((error: { code?: string }) => error.code === 'EAUTH' || error.code === 'EENVELOPE' ? 'failed' as const : 'unknown' as const);
      return await Promise.race([result, new Promise<MailResult>(resolve => {
        timer = setTimeout(() => { socket?.destroy(new Error('MAIL_TIMEOUT')); resolve('unknown'); }, 20000);
      })]);
    } finally { if (timer) clearTimeout(timer); socket?.destroy(); transport?.close(); }
  };
}
