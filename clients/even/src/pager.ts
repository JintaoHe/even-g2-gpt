// Conservative cell budgeting; validate actual font metrics on glasses later.
// Append-only wrapping keeps completed lines stable while text streams in.
export function wrapLines(text: string, columns = 40): string[] {
  const lines: string[] = []; let line = '', used = 0;
  const input = text.replace(/\r/g, '');
  const push = () => { lines.push(line); line = ''; used = 0; };
  const append = (value: string) => {
    for (const char of value) {
      const width = /^[\x20-\x7e]$/.test(char) ? 1 : 2;
      if (used + width > columns) push();
      line += char; used += width;
    }
  };
  for (let i = 0; i < input.length;) {
    const rest = input.slice(i);
    const word = /^[A-Za-z0-9]+(?:[._'’/-][A-Za-z0-9]+)*/.exec(rest)?.[0];
    if (word) {
      if (used > 0 && word.length <= columns && used + word.length > columns) push();
      append(word); i += word.length; continue;
    }
    const char = String.fromCodePoint(input.codePointAt(i)!); i += char.length;
    if (char === '\n') { lines.push(line); line = ''; used = 0; continue; }
    append(char);
  }
  lines.push(line);
  return lines;
}

export function paginate(text: string, columns = 40, rows = 5): string[] {
  const lines = wrapLines(text, columns);
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
