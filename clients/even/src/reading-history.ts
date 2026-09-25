import { paginate, wrapLines } from './pager.ts';
import { displayText } from './display-text.ts';

type Entry = { id?: string; role: '你' | 'Even' | '提示'; raw: string; pending: boolean; interrupted?: boolean };
type SnapshotMessage = { id: string; sequence: number; role: 'user' | 'assistant'; status: 'committed' | 'interrupted'; content: string };
type Segment = { text: string; final: boolean };
type RecoveryCounts = { sending: number; unknown: number };
export class ReadingHistory {
  private readonly lineWindow: boolean;
  private readonly typewriter: boolean;
  private readonly manualPages: boolean;
  constructor(mode: boolean | 'manual-pages' = false, typewriter = false) {
    this.manualPages = mode === 'manual-pages';
    this.lineWindow = mode === true; this.typewriter = !this.manualPages && typewriter;
  }
  private typing?: { entry: Entry; shown: number; nextAt?: number; source: string; points: string[] };
  private beginTyping(entry: Entry) {
    if (this.typewriter) this.typing = { entry, shown: 0, source: '', points: [] };
  }
  private typingPoints(): string[] {
    if (!this.typing) return [];
    const text = displayText(this.typing.entry.raw, this.typing.entry.pending);
    if (text !== this.typing.source) {
      this.typing.source = text; this.typing.points = Array.from(text);
      this.typing.shown = Math.min(this.typing.shown, this.typing.points.length);
    }
    return this.typing.points;
  }
  private frozenView: string | undefined;
  private lineCache: { text: string; lines: string[] } | undefined;
  private nextAdvance: number | undefined;
  private advanced = false;
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
    this.typing = undefined;
    this.entries = [{ role: '提示', raw: text, pending: false }]; this.index = this.page = 0;
    this.draft = this.answer = undefined; this.segments.clear(); this.answerId = undefined; this.manual = false; this.speaking = false;
    this.recoveryEntry = undefined; this.recoveryMail = this.recoveryCalendar = undefined;
    this.frozenView = undefined; this.lineCache = undefined;
    this.nextAdvance = undefined; this.advanced = false;
  }
  restoreSnapshot(messages: SnapshotMessage[], replace = false) {
    if (replace) {
      this.typing = undefined;
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
  private select(entry: Entry) {
    this.index = this.entries.indexOf(entry); this.page = 0; this.manual = false; this.frozenView = undefined;
    this.nextAdvance = undefined; this.advanced = false;
  }
  private question() {
    if (!this.draft) { this.typing = undefined; this.draft = { role: '你', raw: '', pending: true }; this.entries.push(this.draft); this.select(this.draft); }
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
      if (existing) { this.answer = existing; this.answer.pending = true; this.answerId = event.id; this.beginTyping(existing); if (!this.manual) this.select(existing); return; }
      this.answer = { role: 'Even', raw: '', pending: true }; this.answerId = event.id;
      if (typeof event.message_id === 'string') this.answer.id = event.message_id;
      this.entries.push(this.answer);
      this.beginTyping(this.answer);
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
  // Called with monotonic time by the display timer. Never catch up multiple rows
  // after a suspended WebView: model throughput must not set reading speed.
  advanceReading(now: number): boolean {
    if (this.typewriter) {
      const typing = this.typing;
      if (!typing) return false;
      if (this.manual || this.selected !== typing.entry || typing.entry.interrupted) { typing.nextAt = undefined; return false; }
      const points = this.typingPoints();
      if (typing.shown >= points.length) { typing.nextAt = undefined; return false; }
      typing.nextAt ??= now;
      let added = 0;
      while (typing.shown < points.length && now >= typing.nextAt && added < 3) {
        const point = points[typing.shown++]; added++;
        if (/[。！？.!?\n]/u.test(point)) { typing.nextAt = now + 650; break; }
        if (/[，、,;；:：]/u.test(point)) { typing.nextAt = now + 350; break; }
        typing.nextAt += 125;
      }
      // Background/slow BLE must never cause a catch-up burst.
      if (added === 3 && typing.nextAt <= now) typing.nextAt = now + 125;
      if (added) this.page = this.maxPosition;
      return added > 0;
    }
    if (!this.lineWindow || this.manual || this.selected?.role !== 'Even'
      || this.selected.interrupted || this.page >= this.maxPosition) {
      this.nextAdvance = undefined; return false;
    }
    if (this.nextAdvance === undefined) {
      this.nextAdvance = now + (this.advanced ? 1800 : 4000); return false;
    }
    if (now < this.nextAdvance) return false;
    this.page++; this.advanced = true; this.nextAdvance = now + 1800;
    return true;
  }
  get selected() { return this.entries[this.index]; }
  private get visibleText() {
    const entry = this.selected;
    if (entry && this.typing?.entry === entry) return this.typingPoints().slice(0, this.typing.shown).join('');
    return entry ? (entry.role === 'Even' ? displayText(entry.raw, entry.pending) : entry.raw) : '';
  }
  get lines() {
    if (!this.lineWindow) return wrapLines(this.visibleText);
    const text = this.visibleText;
    if (this.lineCache?.text === text) return this.lineCache.lines;
    // Stable append-only wrapping, as validated in Scroll Probe; no trailing-word reflow.
    const lines = ['']; let width = 0;
    for (const point of text) {
      if (point === '\r') continue;
      if (point === '\n') { lines.push(''); width = 0; continue; }
      const size = point.codePointAt(0)! > 127 ? 2 : 1;
      if (width + size > 32) { lines.push(''); width = 0; }
      lines[lines.length - 1] += point; width += size;
    }
    this.lineCache = { text, lines }; return lines;
  }
  // Pagination is intentionally non-overlapping. Repeating two old lines on
  // every gesture was disorienting on the five-line glasses display.
  get scrolling() { return this.lineWindow; }
  get pages() {
    return this.manualPages ? paginate(this.visibleText, 40, 6) : paginate(this.visibleText);
  }
  private get maxPosition() { return Math.max(0, this.lineWindow ? this.lines.length - 6 : this.pages.length - 1); }
  get current() {
    const text = this.manualPages ? this.pages[this.page]
      : this.lineWindow ? this.frozenView ?? this.lines.slice(this.page, this.page + 6).join('\n') : this.pages[this.page];
    return text || (this.typing && this.typing.entry === this.selected && this.typingPoints().length > this.typing.shown ? '正在显示回答…'
      : this.selected?.pending ? this.selected.role === '你' ? '正在识别文字…' : '正在生成回答…' : '');
  }
  get label() {
    const entry = this.selected;
    if (this.manualPages) return `${entry?.role ?? '提示'} ${entry?.interrupted ? '已打断' : entry?.pending ? '生成中' : '完成'} ${this.page + 1}/${this.pages.length}页`;
    if (this.lineWindow) return `${entry?.role ?? '提示'} ${this.manual ? '回看' : entry?.interrupted ? '打断' : this.typing && this.typing.entry === entry && this.typingPoints().length > this.typing.shown ? '显示' : this.page < this.maxPosition ? '慢读' : entry?.pending ? '生成' : '完成'} ${this.page + 1}-${Math.min(this.page + 6, this.lines.length)}/${this.lines.length}`;
    const phase = entry?.role === '你' ? (entry === this.draft && this.speaking ? ' · 正在说' : entry.pending ? ' · 正在识别' : ' · 已识别')
      : entry?.interrupted ? ' · 已打断' : '';
    const pages = entry?.pending ? `第${this.page + 1}页${this.page < this.pages.length - 1 ? ' · 后有内容' : ''}` : `${this.page + 1}/${this.pages.length}页`;
    return `${entry?.role ?? '提示'}${phase} · ${pages}`;
  }
  move(direction: number) {
    if (this.manualPages) {
      this.manual = true; this.frozenView = undefined;
      if (direction < 0) {
        if (this.page > 0) this.page--;
        else if (this.index > 0) { this.index--; this.page = this.maxPosition; }
      } else if (this.page < this.maxPosition) this.page++;
      else if (this.index < this.entries.length - 1) { this.index++; this.page = 0; }
      return;
    }
    if (this.lineWindow) {
      if (this.typing) this.typing.nextAt = undefined;
      this.nextAdvance = undefined; this.advanced = false;
      this.frozenView = undefined; this.manual = true;
      if (direction < 0) {
        if (this.page > 0) this.page--;
        else if (this.index > 0) { this.index--; this.page = this.maxPosition; }
      } else if (this.page < this.maxPosition) this.page++;
      else if (this.index < this.entries.length - 1) { this.index++; this.page = 0; }
      if (direction > 0 && this.index === this.entries.length - 1 && this.page === this.maxPosition) this.manual = false;
      if (this.manual) this.frozenView = this.lines.slice(this.page, this.page + 6).join('\n');
      return;
    }
    this.manual = true;
    if (direction < 0) {
      if (this.page > 0) this.page--;
      else if (this.index > 0) { this.index--; this.page = this.maxPosition; }
    } else if (this.page < this.pages.length - 1) this.page++;
    else if (this.index < this.entries.length - 1) { this.index++; this.page = 0; }
  }
  latest() {
    if (this.typing) { this.typing.shown = this.typingPoints().length; this.typing.nextAt = undefined; }
    this.index = Math.max(0, this.entries.length - 1); this.page = this.lineWindow ? this.maxPosition : 0;
    this.manual = false; this.frozenView = undefined; this.nextAdvance = undefined; this.advanced = false;
  }
}
