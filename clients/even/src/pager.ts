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
  const input = text.replace(/\r/g, '');
  const logical = input.split('\n');
  const blocks: { kind: 'plain' | 'point'; text: string }[] = [];
  let current: { kind: 'plain' | 'point'; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    while (current.lines.at(-1) === '') current.lines.pop();
    if (current.lines.length) blocks.push({ kind: current.kind, text: current.lines.join('\n') });
    current = undefined;
  };
  for (const line of logical) {
    const point = /^\s*(?:[-*•]|\d+[.)、）])\s+/.test(line);
    if (point) { flush(); current = { kind: 'point', lines: [line] }; continue; }
    if (!line.trim()) { flush(); continue; }
    if (!current) current = { kind: 'plain', lines: [line] };
    else current.lines.push(line);
  }
  flush();
  if (!blocks.length) return [''];

  const pages: string[] = [];
  let page: string[] = [];
  const pushPage = () => { if (page.length) pages.push(page.join('\n')); page = []; };
  const addChunked = (lines: string[], keepTogether: boolean) => {
    // Keep a short semantic point together when it fits, but do not force every
    // bullet onto its own mostly-empty page. Pages remain strictly non-overlapping.
    if (keepTogether && lines.length <= rows && page.length && page.length + lines.length > rows) pushPage();
    for (const line of lines) {
      if (page.length >= rows) pushPage();
      page.push(line);
    }
  };
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], lines = wrapLines(block.text, columns);
    addChunked(lines, block.kind === 'point');
  }
  pushPage();
  return pages.length ? pages : [''];
}
export class Pager {
  text = ''; index = 0;
  reset(text = '') { this.text = text; this.index = 0; }
  append(text: string) { this.text += text; }
  move(delta: number) { this.index = Math.max(0, Math.min(this.pages.length - 1, this.index + delta)); }
  get pages() { return paginate(this.text); }
  get current() { return this.pages[this.index] ?? ''; }
}
