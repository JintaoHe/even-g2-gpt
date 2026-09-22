/** Stable conversation wire contract. Protocol v2 is defined independently
 * from the current WebSocket handler so it can be tested before cut-over. */

export const CONVERSATION_PROTOCOL_VERSION = 2 as const;

export const CONNECTION_STATES = ['disconnected', 'connecting', 'connected', 'recovering'] as const;
export type ConnectionState = typeof CONNECTION_STATES[number];

export const AUDIO_STATES = ['off', 'starting', 'streaming', 'unavailable', 'requires_reopen'] as const;
export type AudioState = typeof AUDIO_STATES[number];

export const CONVERSATION_STATES = ['idle', 'listening', 'thinking', 'answering', 'paused', 'exit_pending', 'closed'] as const;
export type DurableConversationState = typeof CONVERSATION_STATES[number];

const CONNECTION_TRANSITIONS = {
  disconnected: ['connecting'],
  connecting: ['connected', 'disconnected'],
  connected: ['recovering', 'disconnected'],
  recovering: ['connected', 'disconnected'],
} as const satisfies Record<ConnectionState, readonly ConnectionState[]>;

const AUDIO_TRANSITIONS = {
  off: ['starting'],
  starting: ['streaming', 'unavailable', 'requires_reopen', 'off'],
  streaming: ['off', 'unavailable', 'requires_reopen'],
  unavailable: ['starting', 'off'],
  requires_reopen: ['off'],
} as const satisfies Record<AudioState, readonly AudioState[]>;

const CONVERSATION_TRANSITIONS = {
  idle: ['listening', 'paused', 'closed'],
  listening: ['idle', 'thinking', 'paused', 'exit_pending', 'closed'],
  thinking: ['idle', 'answering', 'listening', 'paused', 'exit_pending', 'closed'],
  answering: ['idle', 'listening', 'paused', 'exit_pending', 'closed'],
  paused: ['idle', 'listening', 'exit_pending', 'closed'],
  exit_pending: ['paused', 'closed'],
  closed: [],
} as const satisfies Record<DurableConversationState, readonly DurableConversationState[]>;

export function canTransitionConnection(from: ConnectionState, to: ConnectionState) {
  return (CONNECTION_TRANSITIONS[from] as readonly ConnectionState[]).includes(to);
}

export function canTransitionAudio(from: AudioState, to: AudioState) {
  return (AUDIO_TRANSITIONS[from] as readonly AudioState[]).includes(to);
}

export function canTransitionConversation(from: DurableConversationState, to: DurableConversationState) {
  return (CONVERSATION_TRANSITIONS[from] as readonly DurableConversationState[]).includes(to);
}

export type HelloMessageV2 = {
  type: 'hello';
  protocol_version: typeof CONVERSATION_PROTOCOL_VERSION;
  client_id: string;
  token?: string;
  resume_session_id?: string;
  resume_credential?: string;
  device_credential?: string;
  credential_storage?: 'even_host_v1' | 'browser_v1';
  last_seen_sequence?: number;
  client_capabilities?: { location: boolean; guest_mode?: boolean };
};

export type CredentialPersistedMessageV2 = {
  type: 'credential.persisted';
  credential_id: string;
};

export type TextSubmitMessageV2 = {
  type: 'text.submit';
  message_id: string;
  text: string;
};

export type CommandType = 'turn.submit' | 'pause' | 'resume' | 'interrupt' | 'answer.retry' | 'exit.request';
export type CommandMessageV2 = { type: CommandType; command_id: string };
export type ExitConfirmMessageV2 = { type: 'exit.confirm'; command_id: string; confirm: boolean };
export type LocalTestControlType = 'test.session.expire' | 'test.storage.inspect' | 'test.storage.seed_expired'
  | 'test.storage.cleanup_preview' | 'test.storage.cleanup_apply';
export type LocalTestControlMessageV2 = { type: LocalTestControlType; command_id: string };

export type CoreClientMessageV2 = HelloMessageV2 | TextSubmitMessageV2 | CommandMessageV2
  | ExitConfirmMessageV2 | CredentialPersistedMessageV2 | LocalTestControlMessageV2;

export type SnapshotMessageV2 = {
  id: string;
  turn_id?: string;
  topic_id?: string;
  sequence: number;
  role: 'user' | 'assistant';
  status: 'committed' | 'interrupted';
  content: string;
  created_at: number;
};

export type ConversationSnapshotV2 = {
  state: DurableConversationState;
  messages: SnapshotMessageV2[];
  interrupted_turn_id?: string;
};

export type ReadyEventV2 = {
  type: 'ready';
  protocol_version: typeof CONVERSATION_PROTOCOL_VERSION;
  connection_id: string;
  session_id: string;
  resumed: boolean;
  latest_sequence: number;
  resume_window_minutes: number;
  resume_credential: string;
  resume_expires_at: number;
  device_credential_id?: string;
  device_credential?: string;
  device_expires_at?: number;
  device_persist_deadline_at?: number;
  snapshot: ConversationSnapshotV2;
};

/** A connected client periodically receives a replacement short-lived
 * credential so a long-lived socket can still recover after a later drop.
 * The client must persist this value in the same restricted storage used for
 * the credential returned by `ready` and replace the previous value. */
export type ResumeCredentialEventV2 = {
  type: 'resume.credential';
  session_id: string;
  resume_credential: string;
  resume_expires_at: number;
};

export type MessageAckEventV2 = {
  type: 'message.ack';
  session_id: string;
  message_id: string;
  sequence: number;
  result: 'committed' | 'duplicate';
};

type AnswerEventIdentityV2 = {
  session_id: string;
  turn_id: string;
  message_id: string;
};

export type AnswerStartEventV2 = AnswerEventIdentityV2 & { type: 'answer.start' };
export type AnswerDeltaEventV2 = AnswerEventIdentityV2 & { type: 'answer.delta'; text: string };
export type AnswerCommittedEventV2 = AnswerEventIdentityV2 & {
  type: 'answer.committed';
  sequence: number;
  content: string;
};

export type CoreServerEventV2 = ReadyEventV2 | ResumeCredentialEventV2 | MessageAckEventV2 | AnswerStartEventV2
  | AnswerDeltaEventV2 | AnswerCommittedEventV2;

type PersistencePolicy = 'none' | 'session-state' | 'durable-before-ack';
type IdempotencyPolicy = 'credential' | 'message_id' | 'command_id';
type ReplayPolicy = 'authenticate-once' | 'return-original-ack' | 'safe-state-command'
  | 'never-replay-automatically' | 'development-only';

export type ClientMessagePolicy = {
  persistence: PersistencePolicy;
  idempotency: IdempotencyPolicy;
  replay: ReplayPolicy;
  production?: boolean;
};

export const CLIENT_MESSAGE_POLICY = {
  hello: { persistence: 'none', idempotency: 'credential', replay: 'authenticate-once' },
  'text.submit': { persistence: 'durable-before-ack', idempotency: 'message_id', replay: 'return-original-ack' },
  'turn.submit': { persistence: 'session-state', idempotency: 'command_id', replay: 'safe-state-command' },
  pause: { persistence: 'session-state', idempotency: 'command_id', replay: 'safe-state-command' },
  resume: { persistence: 'session-state', idempotency: 'command_id', replay: 'safe-state-command' },
  interrupt: { persistence: 'session-state', idempotency: 'command_id', replay: 'safe-state-command' },
  'answer.retry': { persistence: 'session-state', idempotency: 'command_id', replay: 'never-replay-automatically' },
  'exit.request': { persistence: 'session-state', idempotency: 'command_id', replay: 'safe-state-command' },
  'exit.confirm': { persistence: 'session-state', idempotency: 'command_id', replay: 'safe-state-command' },
  'credential.persisted': { persistence: 'none', idempotency: 'credential', replay: 'authenticate-once' },
  'test.session.expire': {
    persistence: 'none', idempotency: 'command_id', replay: 'development-only', production: false,
  },
  'test.storage.inspect': {
    persistence: 'none', idempotency: 'command_id', replay: 'development-only', production: false,
  },
  'test.storage.seed_expired': {
    persistence: 'none', idempotency: 'command_id', replay: 'development-only', production: false,
  },
  'test.storage.cleanup_preview': {
    persistence: 'none', idempotency: 'command_id', replay: 'development-only', production: false,
  },
  'test.storage.cleanup_apply': {
    persistence: 'none', idempotency: 'command_id', replay: 'development-only', production: false,
  },
} as const satisfies Record<CoreClientMessageV2['type'], ClientMessagePolicy>;

export class ProtocolValidationError extends Error {
  readonly code = 'INVALID_PROTOCOL_MESSAGE';
  constructor() { super('Invalid conversation protocol message'); this.name = 'ProtocolValidationError'; }
}

type ParseOptions = { allowLocalTestControls?: boolean };
type JsonRecord = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_TYPES = new Set<CommandType>(['turn.submit', 'pause', 'resume', 'interrupt', 'answer.retry', 'exit.request']);
const LOCAL_TEST_CONTROL_TYPES = new Set<LocalTestControlType>([
  'test.session.expire', 'test.storage.inspect', 'test.storage.seed_expired',
  'test.storage.cleanup_preview', 'test.storage.cleanup_apply',
]);

function invalid(): never { throw new ProtocolValidationError(); }
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as JsonRecord;
}
function exactKeys(value: JsonRecord, allowed: readonly string[]) {
  const set = new Set(allowed);
  if (Object.keys(value).some(key => !set.has(key))) invalid();
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}
function credential(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 2048) invalid();
  return value;
}
function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

export function parseCoreClientMessage(input: unknown, options: ParseOptions = {}): CoreClientMessageV2 {
  const value = record(input);
  if (typeof value.type !== 'string') invalid();

  if (value.type === 'hello') {
    exactKeys(value, ['type', 'protocol_version', 'client_id', 'token', 'resume_session_id', 'resume_credential',
      'device_credential', 'credential_storage', 'last_seen_sequence', 'client_capabilities']);
    if (value.protocol_version !== CONVERSATION_PROTOCOL_VERSION) invalid();
    const tokenPresent = value.token !== undefined, resumePresent = value.resume_credential !== undefined;
    const devicePresent = value.device_credential !== undefined;
    if (Number(tokenPresent) + Number(resumePresent) + Number(devicePresent) !== 1) invalid();
    const result: HelloMessageV2 = {
      type: 'hello', protocol_version: CONVERSATION_PROTOCOL_VERSION, client_id: uuid(value.client_id),
    };
    if (value.client_capabilities !== undefined) {
      const capabilities = record(value.client_capabilities);
      exactKeys(capabilities, ['location', 'guest_mode']);
      if (typeof capabilities.location !== 'boolean') invalid();
      result.client_capabilities = { location: capabilities.location };
      if (capabilities.guest_mode !== undefined) {
        if (typeof capabilities.guest_mode !== 'boolean') invalid();
        result.client_capabilities.guest_mode = capabilities.guest_mode;
      }
    }
    if (value.credential_storage !== undefined) {
      if (value.credential_storage !== 'even_host_v1' && value.credential_storage !== 'browser_v1') invalid();
      result.credential_storage = value.credential_storage;
    }
    if (tokenPresent) result.token = credential(value.token);
    if (value.resume_session_id !== undefined) result.resume_session_id = uuid(value.resume_session_id);
    if (resumePresent) {
      if (!result.resume_session_id) invalid();
      result.resume_credential = credential(value.resume_credential);
    }
    if (devicePresent) {
      if (result.resume_session_id || value.last_seen_sequence !== undefined
        || !['even_host_v1', 'browser_v1'].includes(String(value.credential_storage))) invalid();
      result.device_credential = credential(value.device_credential);
    }
    if (value.last_seen_sequence !== undefined) {
      if (!result.resume_session_id) invalid();
      result.last_seen_sequence = sequence(value.last_seen_sequence);
    }
    return result;
  }

  if (value.type === 'credential.persisted') {
    exactKeys(value, ['type', 'credential_id']);
    return { type: 'credential.persisted', credential_id: uuid(value.credential_id) };
  }

  if (value.type === 'text.submit') {
    exactKeys(value, ['type', 'message_id', 'text']);
    if (typeof value.text !== 'string') invalid();
    const text = value.text.trim();
    if (!text || text.length > 6000) invalid();
    return { type: 'text.submit', message_id: uuid(value.message_id), text };
  }

  if (COMMAND_TYPES.has(value.type as CommandType)) {
    exactKeys(value, ['type', 'command_id']);
    return { type: value.type as CommandType, command_id: uuid(value.command_id) };
  }

  if (value.type === 'exit.confirm') {
    exactKeys(value, ['type', 'command_id', 'confirm']);
    if (typeof value.confirm !== 'boolean') invalid();
    return { type: 'exit.confirm', command_id: uuid(value.command_id), confirm: value.confirm };
  }

  if (LOCAL_TEST_CONTROL_TYPES.has(value.type as LocalTestControlType)) {
    exactKeys(value, ['type', 'command_id']);
    if (!options.allowLocalTestControls) invalid();
    return { type: value.type as LocalTestControlType, command_id: uuid(value.command_id) };
  }

  invalid();
}
