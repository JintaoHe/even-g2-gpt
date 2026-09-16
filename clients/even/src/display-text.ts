// Display-only transformation. Never send this text back to storage or the model.
export function displayText(raw: string, streaming = false): string {
  let text = raw;
  // Hold an unfinished last token so fragmented URLs/Markdown never flash on screen.
  if (streaming) text = text.replace(/[A-Za-z0-9_:/?&=%#.@~+%-]+$/, '');
  text = text.replace(/^\s*\[[^\]\n]+\]:\s*https?:\/\/[^\n]*$/gm, '');
  text = text.replace(/!?\[([^\]\n]*)\]\([^)]*(?:\)|$)/g, '$1');
  text = text.replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1');
  // Buffer incomplete Markdown labels rather than exposing syntax during streaming.
  if (streaming) text = text.replace(/\[[^\]\n]*\]?$/, '');
  text = text.replace(/<https?:\/\/[^>]*(?:>|$)/gi, '');
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s<>\u3000-\u303f\uff00-\uffef]+/gi, '');
  text = text.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\/[^\s<>\u3000-\u303f\uff00-\uffef]*)?/gi, '');
  text = text.replace(/cite[^]*/g, '').replace(/【[^】]*†[^】]*】/g, '');
  text = text.replace(/^#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '');
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
