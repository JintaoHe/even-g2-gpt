// Explicit user-authorized synthetic acceptance tests. No model calls or private conversation.
import 'dotenv/config';
import { resolve } from 'node:path';
import { JobStore } from '../src/job-store.js';
import { createMailSender, mailPayload } from '../src/mail.js';
import { presentation } from '../src/document-presentation.js';
import { calendarDetails, type CalendarEvent } from '../src/calendar.js';

async function main() {
  const kind = process.argv[process.argv.indexOf('--case') + 1];
  if (!process.argv.includes('--send') || !['md', 'ics', 'both'].includes(kind)) throw Error('EXPLICIT_TEST_REQUIRED');
  if (kind !== 'md' && !process.argv.includes('--confirm-chicago-test-time')) throw Error('CALENDAR_APPROVAL_REQUIRED');
  const calendar: CalendarEvent | undefined = kind === 'md' ? undefined : {
    title: 'Even 日历测试—非真实安排', start: '2026-10-01T18:00-05:00', end: '2026-10-01T18:15-05:00', timezone: 'America/Chicago',
    allDay: false, location: '', notes: '用户主动请求的附件兼容性测试，不是真实约会。无闹钟；无需导入，若导入请在测试后自行删除。'
  };
  const number = { md: '01', ics: '02', both: '03' }[kind];
  const title = `验收测试${number}—${kind === 'md' ? 'Markdown 文档' : kind === 'ics' ? 'ICS 日历附件' : '文档与日历组合'}`;
  const summary = kind === 'md' ? '这是你主动请求的第一封测试邮件，仅附带 Markdown 文档，用于检查标题、正文摘要和文件可读性。不包含任何私人对话或凭据。'
    : `这是你主动请求的第${kind === 'ics' ? '二' : '三'}封测试邮件，${kind === 'ics' ? '仅附带 ICS 日历文件' : '附带 Markdown 文档和 ICS 日历文件'}。日程是虚拟测试安排，以美国芝加哥时间为准，不设置闹钟，不会自动添加到日历；请先核对下方时间。`;
  const metadata = presentation(title, summary, 'summary');
  const markdown = `# ${title}\n\n## 测试目的\n\n${summary}\n\n## 验收步骤\n\n1. 核对发件人为 Even Assistant 系统通知。\n2. 检查邮件标题、摘要和附件名称。\n3. 打开附件，确认中文内容可正常阅读。\n\n${calendar ? '## 测试日程\n\n' + calendarDetails(calendar) + '\n\n仅为格式测试，非真实安排。\n' : ''}\n## 安全说明\n\n此邮件由你主动请求，不要求登录、付款或提供密码。不包含私人聊天、录音或密钥。\n`;
  const store = await JobStore.create(resolve('.local', 'mail-acceptance-v1', kind));
  try {
    const job = store.list()[0] ?? store.enqueueDocument({ markdown, presentation: metadata }, calendar);
    for (let n = 0; n < 200 && ['queued', 'running'].includes(store.get(job.id)!.state); n++) await new Promise(r => setTimeout(r, 25));
    const bytes = await store.download(job.id);
    const payload = mailPayload(job.id, bytes, store.metadata(job.id), store.calendar(job.id), job.created, kind === 'ics');
    const sender = createMailSender(process.env, { calendarOnly: kind === 'ics' });
    if (!sender) throw Error('MAIL_DISABLED');
    const result = await store.email(job.id, sender);
    console.log(JSON.stringify({ test: kind, result, subject: payload.subject, attachments: payload.attachments.map(a => a.filename) }));
    if (result !== 'accepted') process.exitCode = 1;
  } finally { await store.close(); }
}
main().catch(() => { console.error('MAIL_ACCEPTANCE_FAILED (no credentials logged; do not blindly retry)'); process.exitCode = 1; });
