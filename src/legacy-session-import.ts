import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ConversationStore, ConversationStoreConflictError, type LegacySessionImport } from './conversation-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 10_000;

export type LegacyImportErrorCode = 'INVALID_FILENAME' | 'SYMLINK' | 'UNSUPPORTED_ENTRY' | 'OVERSIZED'
  | 'INVALID_JSON' | 'INVALID_SCHEMA' | 'IMPORT_CONFLICT' | 'IMPORT_FAILED';

export type LegacyImportReport = {
  scanned: number;
  valid: number;
  imported: number;
  duplicates: number;
  quarantined: number;
  errors: Array<{ file: string; code: LegacyImportErrorCode }>;
};

type RawMessage = {
  role: 'user' | 'assistant';
  content: string;
  citations?: Array<{ start: number; end: number; url: string; title: string }>;
  topicId?: string;
  topicLabel?: string;
  cognitiveMode?: string;
  assistantMode?: string;
};

type RawSession = { session_id: string; updated_at: string; history: RawMessage[] };

function deterministicUuid(seed: string) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validCitation(value: unknown) {
  if (!isObject(value)) return false;
  return Number.isSafeInteger(value.start) && Number(value.start) >= 0
    && Number.isSafeInteger(value.end) && Number(value.end) >= Number(value.start)
    && typeof value.url === 'string' && value.url.length > 0 && value.url.length <= 4_096
    && typeof value.title === 'string' && value.title.length <= 500;
}

function parseLegacySession(value: unknown, expectedId: string): RawSession {
  if (!isObject(value) || value.session_id !== expectedId || typeof value.updated_at !== 'string'
    || !Array.isArray(value.history) || value.history.length > MAX_MESSAGES) throw new Error('INVALID_SCHEMA');
  const updatedAt = Date.parse(value.updated_at);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error('INVALID_SCHEMA');
  const history: RawMessage[] = value.history.map(item => {
    if (!isObject(item) || !['user', 'assistant'].includes(String(item.role)) || typeof item.content !== 'string') {
      throw new Error('INVALID_SCHEMA');
    }
    const content = item.content.trim();
    if (!content || content.length > 120_000) throw new Error('INVALID_SCHEMA');
    if (item.citations !== undefined && (!Array.isArray(item.citations) || item.citations.length > 100
      || !item.citations.every(validCitation) || Buffer.byteLength(JSON.stringify(item.citations)) > 65_536)) {
      throw new Error('INVALID_SCHEMA');
    }
    if (item.topicId !== undefined && typeof item.topicId !== 'string') throw new Error('INVALID_SCHEMA');
    if (item.topicLabel !== undefined && (typeof item.topicLabel !== 'string'
      || !item.topicLabel.trim() || item.topicLabel.trim().length > 80)) throw new Error('INVALID_SCHEMA');
    for (const field of ['cognitiveMode', 'assistantMode'] as const) {
      if (item[field] !== undefined && (typeof item[field] !== 'string' || !item[field] || item[field].length > 64)) {
        throw new Error('INVALID_SCHEMA');
      }
    }
    return {
      role: item.role as 'user' | 'assistant', content,
      ...(item.citations === undefined ? {} : { citations: item.citations as RawMessage['citations'] }),
      ...(item.topicId === undefined ? {} : { topicId: item.topicId }),
      ...(item.topicLabel === undefined ? {} : { topicLabel: item.topicLabel.trim() }),
      ...(item.cognitiveMode === undefined ? {} : { cognitiveMode: item.cognitiveMode as string }),
      ...(item.assistantMode === undefined ? {} : { assistantMode: item.assistantMode as string }),
    };
  });
  return { session_id: expectedId, updated_at: value.updated_at, history };
}

function toImport(raw: RawSession, sourceHash: string, sourceName: string, importedAt: number): LegacySessionImport {
  const endedAt = Date.parse(raw.updated_at);
  const createdAt = Math.max(0, endedAt - Math.max(0, raw.history.length - 1));
  const topics = new Map<string, LegacySessionImport['topics'][number]>();
  const messages: LegacySessionImport['messages'] = [];
  const turns: LegacySessionImport['turns'] = [];
  let openTurn: LegacySessionImport['turns'][number] | undefined;

  raw.history.forEach((message, index) => {
    const at = createdAt + index;
    const label = message.topicLabel?.trim() || 'Imported legacy conversation';
    const topicKey = message.topicId && UUID.test(message.topicId) ? message.topicId.toLowerCase() : `label:${label}`;
    const topicId = deterministicUuid(`${raw.session_id}:topic:${topicKey}`);
    if (!topics.has(topicId)) topics.set(topicId, { id: topicId, label, createdAt: at, updatedAt: endedAt });
    const messageId = deterministicUuid(`${sourceHash}:message:${index}`);

    if (message.role === 'user') {
      const turnId = deterministicUuid(`${sourceHash}:turn:${index}`);
      openTurn = { id: turnId, topicId, inputMessageId: messageId, status: 'interrupted',
        cognitiveMode: message.cognitiveMode ?? message.assistantMode, createdAt: at, updatedAt: at };
      turns.push(openTurn);
      messages.push({ id: messageId, turnId, topicId, sequence: index + 1, role: 'user', content: message.content,
        ...(message.citations === undefined ? {} : { citations: message.citations }), createdAt: at, updatedAt: at });
      return;
    }

    let turn = openTurn;
    if (!turn || turn.outputMessageId || turn.topicId !== topicId) {
      turn = { id: deterministicUuid(`${sourceHash}:turn:assistant:${index}`), topicId, status: 'committed',
        cognitiveMode: message.cognitiveMode ?? message.assistantMode, createdAt: at, updatedAt: at };
      turns.push(turn);
    }
    turn.outputMessageId = messageId;
    turn.status = 'committed';
    turn.updatedAt = at;
    messages.push({ id: messageId, turnId: turn.id, topicId, sequence: index + 1, role: 'assistant', content: message.content,
      ...(message.citations === undefined ? {} : { citations: message.citations }), createdAt: at, updatedAt: at });
    openTurn = undefined;
  });

  if (!topics.size) {
    const id = deterministicUuid(`${raw.session_id}:topic:empty`);
    topics.set(id, { id, label: 'Imported legacy conversation', createdAt, updatedAt: endedAt });
  }
  return {
    sourceHash, sourceName, importedAt,
    session: { id: raw.session_id, ownerScope: 'legacy-import', createdAt, updatedAt: endedAt, endedAt },
    topics: [...topics.values()], turns, messages,
  };
}

async function quarantine(directory: string, path: string, file: string, code: LegacyImportErrorCode) {
  const quarantineDirectory = join(directory, '.quarantine');
  await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
  const info = await lstat(quarantineDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Legacy quarantine directory is unsafe');
  await rename(path, join(quarantineDirectory, `${basename(file)}.${randomUUID()}.${code.toLowerCase()}`));
}

async function readRegularFile(path: string, metadata: Awaited<ReturnType<typeof lstat>>, maxFileBytes: number) {
  if (metadata.size > maxFileBytes) throw new Error('OVERSIZED');
  let handle;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error: any) {
    if (error?.code === 'ELOOP') throw new Error('SYMLINK');
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) throw new Error('UNSUPPORTED_ENTRY');
    if (opened.size > maxFileBytes) throw new Error('OVERSIZED');
    const bytes = Buffer.alloc(Math.min(maxFileBytes + 1, Math.max(1, opened.size + 1)));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxFileBytes) throw new Error('OVERSIZED');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function importLegacySessions(options: {
  dataDirectory: string;
  apply?: boolean;
  store?: ConversationStore;
  maxFileBytes?: number;
  now?: () => number;
}): Promise<LegacyImportReport> {
  const root = resolve(options.dataDirectory), directory = join(root, 'conversations');
  const apply = options.apply === true, maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new Error('Invalid legacy import size limit');
  if (apply && !options.store) throw new Error('Apply mode requires an open conversation store');
  const report: LegacyImportReport = { scanned: 0, valid: 0, imported: 0, duplicates: 0, quarantined: 0, errors: [] };
  const rootInfo = await lstat(root).catch((error: any) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (rootInfo && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())) throw new Error('Legacy data root is unsafe');
  const directoryInfo = await lstat(directory).catch((error: any) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!directoryInfo) return report;
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Legacy conversation directory is unsafe');
  let entries;
  entries = await readdir(directory, { withFileTypes: true });

  const reject = async (path: string, file: string, code: LegacyImportErrorCode, movable: boolean) => {
    report.errors.push({ file, code });
    if (apply && movable) {
      try { await quarantine(directory, path, file, code); report.quarantined++; }
      catch { report.errors[report.errors.length - 1] = { file, code: 'IMPORT_FAILED' }; }
    }
  };

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.quarantine' || !entry.name.toLowerCase().endsWith('.json')) continue;
    report.scanned++;
    const path = join(directory, entry.name);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try { metadata = await lstat(path); }
    catch { report.errors.push({ file: entry.name, code: 'IMPORT_FAILED' }); continue; }
    if (metadata.isSymbolicLink()) { await reject(path, entry.name, 'SYMLINK', false); continue; }
    if (!metadata.isFile()) { await reject(path, entry.name, 'UNSUPPORTED_ENTRY', false); continue; }
    if (!UUID.test(entry.name.slice(0, -5)) || entry.name.length !== 41) {
      await reject(path, entry.name, 'INVALID_FILENAME', true); continue;
    }
    let bytes: Buffer;
    try { bytes = await readRegularFile(path, metadata, maxFileBytes); }
    catch (error: any) {
      const code = ['OVERSIZED', 'SYMLINK', 'UNSUPPORTED_ENTRY'].includes(error?.message)
        ? error.message as LegacyImportErrorCode : 'IMPORT_FAILED';
      await reject(path, entry.name, code, code !== 'SYMLINK' && code !== 'IMPORT_FAILED');
      continue;
    }
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    let decoded: unknown;
    try { decoded = JSON.parse(bytes.toString('utf8')); }
    catch { await reject(path, entry.name, 'INVALID_JSON', true); continue; }
    let raw: RawSession;
    try { raw = parseLegacySession(decoded, entry.name.slice(0, -5)); }
    catch { await reject(path, entry.name, 'INVALID_SCHEMA', true); continue; }
    report.valid++;
    if (!apply) continue;

    try {
      const result = options.store!.importLegacySession(toImport(raw, sourceHash, entry.name, (options.now ?? Date.now)()));
      if (result === 'duplicate') report.duplicates++;
      else report.imported++;
    } catch (error) {
      if (error instanceof ConversationStoreConflictError) await reject(path, entry.name, 'IMPORT_CONFLICT', true);
      else report.errors.push({ file: entry.name, code: 'IMPORT_FAILED' });
    }
  }
  return report;
}
