export const CHINESE_LONG_FORM_OFFER = '需要我把完整内容整理成 Markdown 文件吗？';
export const ENGLISH_LONG_FORM_OFFER = 'Would you like me to put the full version into a Markdown file?';

export function hasLongFormDocumentOffer(value: string) {
  const text = value.trim();
  return text.endsWith(CHINESE_LONG_FORM_OFFER) || text.endsWith(ENGLISH_LONG_FORM_OFFER);
}

/** One-turn contextual acceptance. This may generate a draft, but never authorizes email. */
export function acceptsLongFormDocumentOffer(value: string) {
  const text = value.trim().replace(/[。！.!]+$/, '').trim();
  if (!text || text.length > 80
    || /(?:不要|不用|不想|取消|算了|别|稍后|以后|改|换|删|not\b|don't|do not|cancel|later|instead)/i.test(text)
    || /[?？]/.test(text)) return false;
  return /^(?:要|要完整长文|想看|嗯[，,、\s]*(?:要|想看)|好(?:的|啊)?|可以|没问题|行|好[，,、\s]*(?:发给我|整理(?:成)?(?:完整)?(?:长文|文档|MD|Markdown)?))$/i.test(text)
    || /^(?:yes|yeah|yep|sure|okay|ok)(?:[，,\s]+(?:please|send it to me|make the document))?$/i.test(text);
}
