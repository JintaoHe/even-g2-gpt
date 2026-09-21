import type { ContextSummary } from './context-builder.js';
function cleanString(value: unknown, maximum: number) {
  return typeof value === 'string' && value.trim() && value.length <= maximum ? value.trim() : undefined;
}

function cleanStrings(value: unknown, maximumItems: number, maximumLength: number) {
  if (!Array.isArray(value) || value.length > maximumItems) return undefined;
  const result = value.map(item => cleanString(item, maximumLength));
  return result.every((item): item is string => !!item) ? result : undefined;
}

/** Runtime validation is deliberately independent of provider JSON-schema promises. */
export function validateContextSummary(value: unknown, throughSequence: number): ContextSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SESSION_SUMMARY_SCHEMA_INVALID');
  const source = value as Record<string, unknown>;
  const expected = ['version', 'throughSequence', 'overview', 'topics', 'confirmedDecisions', 'unresolvedItems'];
  if (Object.keys(source).some(key => !expected.includes(key)) || source.version !== 1
    || source.throughSequence !== throughSequence) throw new Error('SESSION_SUMMARY_SCHEMA_INVALID');
  const overview = cleanString(source.overview, 8_000);
  if (!overview || !Array.isArray(source.topics) || source.topics.length > 24) throw new Error('SESSION_SUMMARY_SCHEMA_INVALID');
  const topics = source.topics.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const topic = item as Record<string, unknown>;
    if (Object.keys(topic).some(key => !['id', 'label', 'summary'].includes(key))) return undefined;
    const id = cleanString(topic.id, 128), label = cleanString(topic.label, 80), summary = cleanString(topic.summary, 4_000);
    return id && label && summary ? { id, label, summary } : undefined;
  });
  const confirmedDecisions = cleanStrings(source.confirmedDecisions, 40, 1_000);
  const unresolvedItems = cleanStrings(source.unresolvedItems, 40, 1_000);
  if (topics.some(item => !item) || !confirmedDecisions || !unresolvedItems) throw new Error('SESSION_SUMMARY_SCHEMA_INVALID');
  return { version: 1, throughSequence, overview, topics: topics as ContextSummary['topics'],
    confirmedDecisions, unresolvedItems };
}
