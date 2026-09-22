import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationAuthPath } from '../src/conversation-auth-path.js';

test('credential dispatch is selected once and incomplete resume cannot fall through to master', () => {
  for (const msg of [{}, { resume_credential: 'secret' }, { resume_credential: 'secret', resume_session_id: '' },
    { resume_credential: null }, { device_credential: 'secret' }, { token: 'secret', resume_credential: 'secret' },
    { token: 'secret', resume_session_id: 'session' }, { device_credential: 'secret', token: 'secret' },
    { token: 1 }, { token: '' }, { token: 'secret', last_seen_sequence: 0 }]) {
    assert.throws(() => conversationAuthPath(msg, true), /Auth/);
  }
  assert.equal(conversationAuthPath({ token: 'secret' }, true), 'master');
  assert.equal(conversationAuthPath({ resume_credential: 'secret', resume_session_id: 'session' }, true), 'resume');
  assert.equal(conversationAuthPath({ device_credential: 'secret', credential_storage: 'even_host_v1' }, true), 'device');
});

test('legacy input always needs a master token even when it includes other credential fields', () => {
  assert.throws(() => conversationAuthPath({ resume_credential: 'secret' }, false), /Auth/);
  assert.equal(conversationAuthPath({ token: 'secret', resume_credential: 'ignored' }, false), 'master');
});
