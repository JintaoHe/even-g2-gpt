import { paginate, wrapLines } from './pager.ts';
import { displayText } from './display-text.ts';

type Entry = { id?: string; role: '你' | 'Even' | '提示'; raw: string; pending: boolean; interrupted?: boolean };
type SnapshotMessage = { id: string; sequence: number; role: 'user' | 'assistant'; status: 'committed' | 'interrupted'; content: string };
type Segment = { text: string; final: boolean };
type RecoveryCounts = { sending: number; unknown: number };
export class ReadingHistory {
  entries: Entry[] = [];
  index = 0; page = 0;
  private draft?: Entry;
  private answer?: Entry;
  private answerId: unknown;
  private manual = false;
  private segments = new Map<unknown, Segment>();
  private speaking = false;
  private recoveryEntry?: Entry;
  private recoveryMail?: RecoveryCounts;
  private recoveryCalendar?: RecoveryCounts;
  reset(text: string) {
    this.entries = [{ role: '提示', raw: text, pending: false }]; this.index = this.page = 0;
    this.draft = this.answer = undefined; this.segments.clear(); this.answerId = undefined; this.manual = false; this.speaking = false;
    this.recoveryEntry = undefined; this.recoveryMail = this.recoveryCalendar = undefined;
  }
  restoreSnapshot(messages: SnapshotMessage[], replace = false) {
    if (replace) {
      this.entries = []; this.index = this.page = 0;
      this.draft = this.answer = undefined; this.answerId = undefined; this.segments.clear(); this.speaking = false;
      this.recoveryEntry = undefined; this.recoveryMail = this.recoveryCalendar = undefined;
    }
    const known = new Set(this.entries.map(entry => entry.id).filter(Boolean));
    for (const message of [...messages].sort((a, b) => a.sequence - b.sequence)) {
      if (!message?.id || known.has(message.id) || !['user', 'assistant'].includes(message.role)
        || !['committed', 'interrupted'].includes(message.status) || typeof message.content !== 'string') continue;
      this.entries.push({ id: message.id, role: message.role === 'user' ? '你' : 'Even', raw: message.content,
        pending: false, interrupted: message.status === 'interrupted' });
      known.add(message.id);
    }
    if (!this.entries.length) this.entries.push({ role: '提示', raw: '会话已恢复，等待你的下一句话。', pending: false });
    this.latest();
  }
  notice(text: string) {
    const entry: Entry = { role: '提示', raw: text, pending: false };
    this.entries.push(entry); if (!this.manual) this.select(entry);
  }
  private select(entry: Entry) { this.index = this.entries.indexOf(entry); this.page = 0; this.manual = false; }
  private question() {
    if (!this.draft) { this.draft = { role: '你', raw: '', pending: true }; this.entries.push(this.draft); this.select(this.draft); }
    return this.draft;
  }
  private recoveryCounts(items: unknown, field: string): RecoveryCounts | undefined {
    if (!Array.isArray(items)) return undefined;
    return {
      sending: items.filter(item => item && typeof item === 'object' && (item as any)[field] === 'sending').length,
      unknown: items.filter(item => item && typeof item === 'object' && (item as any)[field] === 'unknown').length,
    };
  }
  private syncRecoveryNotice() {
    const line = (label: string, counts?: RecoveryCounts) => counts && counts.sending + counts.unknown > 0
      ? `${label}待核实：${counts.sending + counts.unknown}${counts.sending ? `（发送中 ${counts.sending}` : '（'}${counts.sending && counts.unknown ? '，' : ''}${counts.unknown ? `结果不确定 ${counts.unknown}` : ''}）`
      : undefined;
    const warnings = [line('邮件', this.recoveryMail), line('日历', this.recoveryCalendar)].filter(Boolean) as string[];
    if (!warnings.length) {
      if (this.recoveryEntry) this.recoveryEntry.raw = '恢复检查完成：没有待核实的邮件或日历操作。';
      return;
    }
    const raw = `恢复检查\n${warnings.join('\n')}\n不会自动重发或重放；请先核对结果。`;
    if (!this.recoveryEntry) {
      this.recoveryEntry = { role: '提示', raw, pending: false };
      this.entries.push(this.recoveryEntry);
    } else this.recoveryEntry.raw = raw;
    if (!this.manual) this.select(this.recoveryEntry);
  }
  event(event: { type: string; [key: string]: any }) {
    const key = event.segment_id ?? 'legacy';
    if (event.type === 'ready') {
      this.recoveryEntry = undefined;
      const mail = Number(event.recovery?.uncertainMail);
      const calendar = Number(event.recovery?.uncertainCalendar);
      this.recoveryMail = Number.isInteger(mail) && mail >= 0 ? { sending: 0, unknown: mail } : undefined;
      this.recoveryCalendar = Number.isInteger(calendar) && calendar >= 0 ? { sending: 0, unknown: calendar } : undefined;
      this.syncRecoveryNotice();
    }
    if (event.type === 'jobs.list') {
      const counts = this.recoveryCounts(event.jobs, 'mail_state');
      if (counts) { this.recoveryMail = counts; this.syncRecoveryNotice(); }
    }
    if (event.type === 'calendar.list') {
      const counts = this.recoveryCounts(event.operations, 'state');
      if (counts) { this.recoveryCalendar = counts; this.syncRecoveryNotice(); }
    }
    if (event.type === 'speech.started') {
      this.question(); this.speaking = true;
      this.segments.set(key, { text: '', final: false });
    }
    if (event.type === 'speech.ended') this.speaking = false;
    if (event.type === 'transcript.delta' || event.type === 'transcript.final') {
      const draft = this.question(), segment = this.segments.get(key) ?? { text: '', final: false };
      if (event.type === 'transcript.final') { segment.text = event.text; segment.final = true; }
      else if (!segment.final) segment.text += event.text;
      this.segments.set(key, segment);
      draft.raw = [...this.segments.values()].map(s => s.text).filter(Boolean).join('\n');
      draft.pending = [...this.segments.values()].some(s => !s.final);
    }
    if (event.type === 'turn.committed') {
      const existing = typeof event.message_id === 'string' ? this.entries.find(entry => entry.id === event.message_id) : undefined;
      if (existing) { if (!this.manual) this.select(existing); return; }
      const question = this.question(); question.raw = event.text; question.pending = false;
      if (typeof event.message_id === 'string') question.id = event.message_id;
      this.draft = undefined; this.segments.clear(); this.speaking = false;
    }
    if (event.type === 'answer.start') {
      const existing = typeof event.message_id === 'string' ? this.entries.find(entry => entry.id === event.message_id) : undefined;
      if (existing) { this.answer = existing; this.answer.pending = true; this.answerId = event.id; if (!this.manual) this.select(existing); return; }
      this.answer = { role: 'Even', raw: '', pending: true }; this.answerId = event.id;
      if (typeof event.message_id === 'string') this.answer.id = event.message_id;
      this.entries.push(this.answer);
      if (!this.manual) this.select(this.answer);
    }
    if (event.type === 'answer.delta' && event.id === this.answerId && this.answer) this.answer.raw += event.text;
    if (event.type === 'answer.citations' && event.id === this.answerId && this.answer) this.answer.raw = event.text;
    if (event.type === 'answer.committed' && event.id === this.answerId && this.answer) {
      this.answer.raw = event.content; this.answer.pending = false;
      if (typeof event.message_id === 'string') this.answer.id = event.message_id;
    }
    if (['answer.done', 'answer.cancelled'].includes(event.type) && event.id === this.answerId && this.answer) {
      this.answer.pending = false; this.answer.interrupted = event.type === 'answer.cancelled';
      this.answer = undefined; this.answerId = undefined;
    }
    if (event.type === 'state' && ['paused', 'exit_pending', 'closed'].includes(event.state)) {
      this.speaking = false;
      if (this.draft) this.draft.pending = false;
    }
    this.page = Math.min(this.page, this.maxPosition);
  }
  get selected() { return this.entries[this.index]; }
  private get visibleText() {
    const entry = this.selected;
    return entry ? (entry.role === 'Even' ? displayText(entry.raw, entry.pending) : entry.raw) : '';
  }
  get lines() { return wrapLines(this.visibleText); }
  // Pagination is intentionally non-overlapping. Repeating two old lines on
  // every gesture was disorienting on the five-line glasses display.
  get scrolling() { return false; }
  get pages() {
    return paginate(this.visibleText);
  }
  private get maxPosition() { return Math.max(0, this.pages.length - 1); }
  get current() {
    const text = this.pages[this.page];
    return text || (this.selected?.pending ? this.selected.role === '你' ? '正在识别文字…' : '正在生成回答…' : '');
  }
  get label() {
    const entry = this.selected;
    const phase = entry?.role === '你' ? (entry === this.draft && this.speaking ? ' · 正在说' : entry.pending ? ' · 正在识别' : ' · 已识别')
      : entry?.interrupted ? ' · 已打断' : '';
    const pages = entry?.pending ? `第${this.page + 1}页${this.page < this.pages.length - 1 ? ' · 后有内容' : ''}` : `${this.page + 1}/${this.pages.length}页`;
    return `${entry?.role ?? '提示'}${phase} · ${pages}`;
  }
  move(direction: number) {
    this.manual = true;
    if (direction < 0) {
      if (this.page > 0) this.page--;
      else if (this.index > 0) { this.index--; this.page = this.maxPosition; }
    } else if (this.page < this.pages.length - 1) this.page++;
    else if (this.index < this.entries.length - 1) { this.index++; this.page = 0; }
  }
  latest() { this.index = Math.max(0, this.entries.length - 1); this.page = 0; this.manual = false; }
}
