// No HTML injection: both model output and external source titles are untrusted text.
export function renderCitations(body, text, citations) {
  body.replaceChildren();
  const sorted = citations.filter(c => Number.isInteger(c.start) && Number.isInteger(c.end)
    && c.start >= 0 && c.end >= c.start && c.end <= text.length && /^https?:\/\//i.test(c.url))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0, number = 0;
  for (const c of sorted) {
    if (c.start >= cursor) {
      body.append(document.createTextNode(text.slice(cursor, c.start)));
      // Replace the provider's citation marker with a real, accessible inline link.
      cursor = c.end;
    }
    const link = document.createElement('a');
    link.href = c.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = ` [${++number}]`; link.title = c.title || c.url;
    link.setAttribute('aria-label', `来源 ${number}：${c.title || c.url}`);
    body.append(link);
  }
  body.append(document.createTextNode(text.slice(cursor)));
  if (sorted.length) {
    const sources = document.createElement('div'); sources.className = 'sources';
    sorted.forEach((c, index) => {
      const link = document.createElement('a'); link.href = c.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = `${index + 1}. ${c.title || new URL(c.url).hostname}`;
      sources.append(link, document.createElement('br'));
    });
    body.append(sources);
  }
}
