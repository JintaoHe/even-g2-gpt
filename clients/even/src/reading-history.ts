import { paginate, wrapLines } from './pager.ts';
import { displayText } from './display-text.ts';

type Entry = { role: '你' | 'Even' | '提示'; raw: string; pending: boolean; interrupted?: boolean };
type Segment = { text: string; final: boolean };
const VIEW_ROWS = 5;
const SCROLL_STEP = 3;
const SCROLL_THRESHOLD = VIEW_ROWS * 2;
export class ReadingHistory {
  entries: Entry[] = [];
  index = 0; page = 0;
  private draft?: Entry;
  private answer?: Entry;
  private answerId: unknown;
  private manual = false;
  private segments = new Map<unknown, Segment>();
  private speaking = false;
  reset(text: string) {
    this.entries = [{ role: '提示', raw: text, pending: false }]; this.index = this.page = 0;
    this.draft = this.answer = undefined; this.segments.clear(); this.answerId = undefined; this.manual = false; this.speaking = false;
  }
  private select(entry: Entry) { this.index = this.entries.indexOf(entry); this.page = 0; this.manual = false; }
  private question() {
    if (!this.draft) { this.draft = { role: '你', raw: '', pending: true }; this.entries.push(this.draft); this.select(this.draft); }
    return this.draft;
  }
  event(event: { type: string; [key: string]: any }) {
    const key = event.segment_id ?? 'legacy';
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
      const question = this.question(); question.raw = event.text; question.pending = false;
      this.draft = undefined; this.segments.clear(); this.speaking = false;
    }
    if (event.type === 'answer.start') {
      this.answer = { role: 'Even', raw: '', pending: true }; this.answerId = event.id;
      this.entries.push(this.answer);
      if (!this.manual) this.select(this.answer);
    }
    if (event.type === 'answer.delta' && event.id === this.answerId && this.answer) this.answer.raw += event.text;
    if (event.type === 'answer.citations' && event.id === this.answerId && this.answer) this.answer.raw = event.text;
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
  get scrolling() { return this.lines.length > SCROLL_THRESHOLD; }
  get pages() {
    return paginate(this.visibleText);
  }
  private get maxPosition() { return this.scrolling ? Math.max(0, this.lines.length - VIEW_ROWS) : Math.max(0, this.pages.length - 1); }
  get current() {
    const text = this.scrolling ? this.lines.slice(this.page, this.page + VIEW_ROWS).join('\n') : this.pages[this.page];
    return text || (this.selected?.pending ? this.selected.role === '你' ? '正在识别文字…' : '正在生成回答…' : '');
  }
  get label() {
    const entry = this.selected;
    const phase = entry?.role === '你' ? (entry === this.draft && this.speaking ? ' · 正在说' : entry.pending ? ' · 正在识别' : ' · 已识别')
      : entry?.interrupted ? ' · 已打断' : '';
    const pages = this.scrolling
      ? `滚动 ${this.page + 1}–${Math.min(this.page + VIEW_ROWS, this.lines.length)}/${this.lines.length}行`
      : entry?.pending ? `第${this.page + 1}页${this.page < this.pages.length - 1 ? ' · 后有内容' : ''}` : `${this.page + 1}/${this.pages.length}页`;
    return `${entry?.role ?? '提示'}${phase} · ${pages}`;
  }
  move(direction: number) {
    this.manual = true;
    if (this.scrolling) {
      if (direction < 0 && this.page > 0) this.page = Math.max(0, this.page - SCROLL_STEP);
      else if (direction > 0 && this.page < this.maxPosition) this.page = Math.min(this.maxPosition, this.page + SCROLL_STEP);
      else if (direction < 0 && this.index > 0) { this.index--; this.page = this.maxPosition; }
      else if (direction > 0 && this.index < this.entries.length - 1) { this.index++; this.page = 0; }
      return;
    }
    if (direction < 0) {
      if (this.page > 0) this.page--;
      else if (this.index > 0) { this.index--; this.page = this.maxPosition; }
    } else if (this.page < this.pages.length - 1) this.page++;
    else if (this.index < this.entries.length - 1) { this.index++; this.page = 0; }
  }
  latest() { this.index = Math.max(0, this.entries.length - 1); this.page = 0; this.manual = false; }
}
