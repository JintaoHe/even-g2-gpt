import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  AUDIO_STATES,
  CLIENT_MESSAGE_POLICY,
  CONNECTION_STATES,
  CONVERSATION_PROTOCOL_VERSION,
  CONVERSATION_STATES,
  ProtocolValidationError,
  canTransitionAudio,
  canTransitionConnection,
  canTransitionConversation,
  parseCoreClientMessage,
} from '../src/conversation-protocol.js';

const secret = 'x'.repeat(48);

test('protocol v2 accepts one initial credential and rejects ambiguous or unknown hello fields', () => {
  const clientId = randomUUID();
  assert.deepEqual(parseCoreClientMessage({
    type: 'hello', protocol_version: CONVERSATION_PROTOCOL_VERSION, client_id: clientId, token: secret,
  }), {
    type: 'hello', protocol_version: 2, client_id: clientId, token: secret,
  });

  for (const input of [
    { type: 'hello', protocol_version: 1, client_id: clientId, token: secret },
    { type: 'hello', protocol_version: 2, client_id: clientId },
    { type: 'hello', protocol_version: 2, client_id: clientId, token: secret, resume_credential: secret },
    { type: 'hello', protocol_version: 2, client_id: clientId, token: secret, debug: true },
    { type: 'hello', protocol_version: 2, client_id: 'not-a-uuid', token: secret },
  ]) assert.throws(() => parseCoreClientMessage(input), ProtocolValidationError);
});

test('resume hello is bound to a session and a monotonic last-seen sequence', () => {
  const clientId = randomUUID(), sessionId = randomUUID();
  assert.deepEqual(parseCoreClientMessage({
    type: 'hello', protocol_version: 2, client_id: clientId,
    resume_session_id: sessionId, resume_credential: secret, last_seen_sequence: 17,
  }), {
    type: 'hello', protocol_version: 2, client_id: clientId,
    resume_session_id: sessionId, resume_credential: secret, last_seen_sequence: 17,
  });
  assert.throws(() => parseCoreClientMessage({
    type: 'hello', protocol_version: 2, client_id: clientId,
    resume_credential: secret, last_seen_sequence: 0,
  }), ProtocolValidationError);
  assert.throws(() => parseCoreClientMessage({
    type: 'hello', protocol_version: 2, client_id: clientId,
    resume_session_id: sessionId, resume_credential: secret, last_seen_sequence: -1,
  }), ProtocolValidationError);
});

test('durable text submissions require a stable message id and exact bounded input', () => {
  const messageId = randomUUID();
  assert.deepEqual(parseCoreClientMessage({ type: 'text.submit', message_id: messageId, text: '  hello  ' }),
    { type: 'text.submit', message_id: messageId, text: 'hello' });
  for (const input of [
    { type: 'text.submit', text: 'hello' },
    { type: 'text.submit', message_id: 'bad', text: 'hello' },
    { type: 'text.submit', message_id: messageId, text: '   ' },
    { type: 'text.submit', message_id: messageId, text: 'x'.repeat(6001) },
    { type: 'text.submit', message_id: messageId, text: 'hello', extra: 1 },
  ]) assert.throws(() => parseCoreClientMessage(input), ProtocolValidationError);
});

test('core commands are exactly shaped and carry idempotency ids', () => {
  const commandId = randomUUID();
  for (const type of ['turn.submit', 'pause', 'resume', 'interrupt', 'answer.retry', 'exit.request'] as const) {
    assert.deepEqual(parseCoreClientMessage({ type, command_id: commandId }), { type, command_id: commandId });
  }
  assert.deepEqual(parseCoreClientMessage({ type: 'exit.confirm', command_id: commandId, confirm: true }),
    { type: 'exit.confirm', command_id: commandId, confirm: true });
  assert.throws(() => parseCoreClientMessage({ type: 'pause' }), ProtocolValidationError);
  assert.throws(() => parseCoreClientMessage({ type: 'exit.confirm', command_id: commandId, confirm: 'yes' }), ProtocolValidationError);
  assert.throws(() => parseCoreClientMessage({ type: 'made.up', command_id: commandId }), ProtocolValidationError);
});

test('session and storage controls are impossible unless an explicit local-test gate is enabled', () => {
  const commandId = randomUUID();
  for (const type of ['test.session.expire', 'test.storage.inspect', 'test.storage.seed_expired',
    'test.storage.cleanup_preview', 'test.storage.cleanup_apply'] as const) {
    const input = { type, command_id: commandId };
    assert.throws(() => parseCoreClientMessage(input), ProtocolValidationError);
    assert.deepEqual(parseCoreClientMessage(input, { allowLocalTestControls: true }), input);
    assert.throws(() => parseCoreClientMessage({ ...input, retention_days: 1_095 },
      { allowLocalTestControls: true }), ProtocolValidationError);
  }
});

test('device hello is a third exclusive auth mode and persisted ACK is exactly shaped', () => {
  const clientId = randomUUID(), credentialId = randomUUID();
  assert.deepEqual(parseCoreClientMessage({
    type: 'hello', protocol_version: 2, client_id: clientId,
    device_credential: secret, credential_storage: 'even_host_v1',
  }), {
    type: 'hello', protocol_version: 2, client_id: clientId,
    device_credential: secret, credential_storage: 'even_host_v1',
  });
  assert.deepEqual(parseCoreClientMessage({ type: 'credential.persisted', credential_id: credentialId }),
    { type: 'credential.persisted', credential_id: credentialId });
  for (const input of [
    { type: 'hello', protocol_version: 2, client_id: clientId, device_credential: secret },
    { type: 'hello', protocol_version: 2, client_id: clientId, device_credential: secret,
      credential_storage: 'browser' },
    { type: 'hello', protocol_version: 2, client_id: clientId, token: secret,
      device_credential: secret, credential_storage: 'even_host_v1' },
    { type: 'hello', protocol_version: 2, client_id: clientId, device_credential: secret,
      credential_storage: 'even_host_v1', last_seen_sequence: 0 },
    { type: 'credential.persisted', credential_id: 'bad' },
    { type: 'credential.persisted', credential_id: credentialId, secret },
  ]) assert.throws(() => parseCoreClientMessage(input), ProtocolValidationError);
});

test('protocol publishes orthogonal states and an explicit persistence/idempotency policy', () => {
  assert.deepEqual(CONNECTION_STATES, ['disconnected', 'connecting', 'connected', 'recovering']);
  assert.deepEqual(AUDIO_STATES, ['off', 'starting', 'streaming', 'unavailable', 'requires_reopen']);
  assert.deepEqual(CONVERSATION_STATES, ['idle', 'listening', 'thinking', 'answering', 'paused', 'exit_pending', 'closed']);

  assert.deepEqual(CLIENT_MESSAGE_POLICY['text.submit'], {
    persistence: 'durable-before-ack', idempotency: 'message_id', replay: 'return-original-ack',
  });
  assert.equal(CLIENT_MESSAGE_POLICY['test.session.expire'].production, false);
  assert.equal(CLIENT_MESSAGE_POLICY['test.storage.inspect'].production, false);
  assert.equal(CLIENT_MESSAGE_POLICY['test.storage.cleanup_apply'].production, false);
  assert.equal(CLIENT_MESSAGE_POLICY['answer.retry'].replay, 'never-replay-automatically');
});

test('connection, audio and conversation transitions are independent and fail closed', () => {
  assert.equal(canTransitionConnection('disconnected', 'connecting'), true);
  assert.equal(canTransitionConnection('connected', 'recovering'), true);
  assert.equal(canTransitionConnection('disconnected', 'connected'), false);

  assert.equal(canTransitionAudio('off', 'starting'), true);
  assert.equal(canTransitionAudio('starting', 'streaming'), true);
  assert.equal(canTransitionAudio('unavailable', 'starting'), true);
  assert.equal(canTransitionAudio('starting', 'requires_reopen'), true);
  assert.equal(canTransitionAudio('requires_reopen', 'starting'), false);
  assert.equal(canTransitionAudio('off', 'streaming'), false);

  assert.equal(canTransitionConversation('listening', 'thinking'), true);
  assert.equal(canTransitionConversation('answering', 'idle'), true);
  assert.equal(canTransitionConversation('idle', 'listening'), true);
  assert.equal(canTransitionConversation('closed', 'listening'), false);
});
