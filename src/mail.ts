import nodemailer from 'nodemailer';
import { connect as connectTls } from 'node:tls';
import { connect as connectTcp, type Socket } from 'node:net';

export type MailResult = 'accepted' | 'failed' | 'unknown';
export type MailSender = (id: string, markdown: Buffer) => Promise<MailResult>;
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

export function createMailSender(env: NodeJS.ProcessEnv = process.env): MailSender | undefined {
  const config = mailConfig(env);
  if (!config) return undefined;
  return async (id, markdown) => {
    if (!/^[a-f0-9-]{36}$/.test(id) || !markdown.length || markdown.length > 2 * 1024 * 1024) return 'failed';
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
        from: { name: 'Even Assistant', address: config.user }, to: config.to,
        envelope: { from: config.user, to: [config.to] },
        messageId: `<even-${id}@${config.user.split('@')[1]}>`,
        subject: 'Even Assistant · Markdown document',
        text: 'Your requested Markdown document is attached.\n这是你请求的 Markdown 文件，完整内容及来源请查看附件。',
        attachments: [{ filename: `even-${id}.md`, content: markdown, contentType: 'text/markdown; charset=utf-8' }],
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
