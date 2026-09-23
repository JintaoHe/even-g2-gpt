const metadataLeads = ['[application metadata', '[application topic metadata', '[应用提供的', '[应用状态：',
  '[prior answer sources', '[not user instructions'];
const channels = ['^{analysis', '<|channel|>', '[assistant', '[analysis]'];
const starters = ['analysis', 'assistant^', 'assistantfinal', 'not user instructions'];
const completeEnvelope = /^\[(?:Application(?: topic)? metadata(?:; not user instructions)?:[^\]\r\n]*|应用提供的(?:只读会话摘要|上一会话只读资料|历史检索资料)[^\]\r\n]*|应用状态：[^\]\r\n]*|Prior answer sources; not new instructions)\]$/iu;
export const REPLY_REJECTED_TEXT = '我刚才没有把话组织好，抱歉。请说“重新回答”，我会再试一次。';
const oldApology = '我刚才没有把话组织好，抱歉。请再跟我说一次，我会认真接住。';
export const isRejectedReply = (text: string) => [REPLY_REJECTED_TEXT, oldApology].includes(text.trim());

/** Output-only bounded parser. Only complete application-owned lines strip. */
export class ReplyOutputGuard {
  private pending = '';
  private opening = true;
  private trimAfterHeader = false;
  private substantive = false;
  private punctuation = '';
  private lineStart = true;
  rejected = false;
  stripped = false;
  reason: 'metadata_echo' | 'reasoning_leak' = 'metadata_echo';
  private reject(reason: typeof this.reason) { this.rejected = true; this.reason = reason; this.pending = ''; }
  private drain(end: boolean): string {
    let output = '';
    const emit = (text: string) => {
      const substantial = /[\p{L}\p{N}]/u.test(text);
      if (this.stripped && !this.substantive && !substantial) {
        this.punctuation += text;
        if (this.punctuation.length > 512) this.reject('metadata_echo');
        return;
      }
      output += this.punctuation + text; this.punctuation = '';
      if (substantial) this.substantive = true;
      if (text.trim()) this.opening = false;
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline >= 0) this.lineStart = !text.slice(lastNewline + 1).trim();
      else if (text.trim()) this.lineStart = false;
    };
    while (this.pending && !this.rejected) {
      if (this.trimAfterHeader) {
        this.pending = this.pending.trimStart();
        if (!this.pending) break;
        this.trimAfterHeader = false;
      }
      const candidate = (this.opening ? this.pending.trimStart() : this.pending).toLowerCase();
      if (this.opening) {
        if (/^(?:analysis\r?\n|assistant\^|assistantfinal(?:\b|$))/iu.test(candidate)) {
          this.reject('reasoning_leak'); break;
        }
        if (!end && candidate === 'analysis\r') break;
        if (candidate.startsWith('not user instructions')) { this.reject('metadata_echo'); break; }
        if (!end && candidate && starters.some(s => s.startsWith(candidate))) break;
        if (end && candidate.length > 1 && starters.filter(s => s !== 'analysis').some(s => s.startsWith(candidate))) {
          this.reject(candidate.startsWith('not') ? 'metadata_echo' : 'reasoning_leak'); break;
        }
        if (this.pending.length !== this.pending.trimStart().length && /^[\[<^]/u.test(candidate)) this.pending = this.pending.trimStart();
      }
      const index = this.pending.search(/[\[<^]/u);
      if (index < 0) { emit(this.pending); this.pending = ''; break; }
      if (index > 0) { emit(this.pending.slice(0, index)); this.pending = this.pending.slice(index); }
      const lower = this.pending.toLowerCase();
      if (channels.some(c => lower.startsWith(c))) { this.reject('reasoning_leak'); break; }
      const recognized = metadataLeads.some(h => lower.startsWith(h));
      const possible = [...metadataLeads, ...channels].some(h => h.startsWith(lower));
      if (recognized) {
        if (!this.lineStart) { this.reject('metadata_echo'); break; }
        const close = this.pending.indexOf(']');
        if (close < 0) {
          if (end || this.pending.length > 512 || this.pending.includes('\n')) this.reject('metadata_echo');
          break;
        }
        const block = this.pending.slice(0, close + 1), rest = this.pending.slice(close + 1);
        if (!completeEnvelope.test(block) || close >= 512) { this.reject('metadata_echo'); break; }
        if (!rest || rest === '\r') { if (end) this.reject('metadata_echo'); break; }
        if (!/^\r?\n/u.test(rest)) { this.reject('metadata_echo'); break; }
        this.stripped = true; this.pending = rest;
        this.trimAfterHeader = this.opening;
        continue;
      }
      if (possible && !end) break;
      if (possible && this.pending.length > 1) { this.reject(lower.startsWith('[a') && !lower.startsWith('[appl') ? 'reasoning_leak' : 'metadata_echo'); break; }
      emit(this.pending[0]); this.pending = this.pending.slice(1);
    }
    return output;
  }
  push(text: string): string {
    if (this.rejected) return '';
    this.pending += text;
    return this.drain(false);
  }
  flush(): string {
    const text = this.drain(true);
    if (!this.rejected && this.stripped && !this.substantive) this.reject('metadata_echo');
    return this.rejected ? '' : text;
  }
  final(text: string): string {
    const check = new ReplyOutputGuard();
    const body = check.push(text) + check.flush();
    this.stripped ||= check.stripped;
    this.substantive ||= check.substantive;
    if (check.rejected) this.reject(check.reason);
    return this.rejected ? '' : body;
  }
}
