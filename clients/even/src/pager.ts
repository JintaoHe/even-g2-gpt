// Conservative cell budgeting; validate actual font metrics on glasses later.
// Append-only wrapping keeps completed pages stable while text streams in.
export function paginate(text: string, columns = 40, rows = 5): string[] {
  const lines: string[] = []; let line = '', used = 0;
  for (const char of text.replace(/\r/g, '')) {
    if (char === '\n') { lines.push(line); line = ''; used = 0; continue; }
    const width = /^[\x20-\x7e]$/.test(char) ? 1 : 2;
    if (used + width > columns) { lines.push(line); line = ''; used = 0; }
    line += char; used += width;
  }
  lines.push(line);
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows).join('\n'));
  return pages;
}
export class Pager {
  text = ''; index = 0;
  reset(text = '') { this.text = text; this.index = 0; }
  append(text: string) { this.text += text; }
  move(delta: number) { this.index = Math.max(0, Math.min(this.pages.length - 1, this.index + delta)); }
  get pages() { return paginate(this.text); }
  get current() { return this.pages[this.index] ?? ''; }
}
