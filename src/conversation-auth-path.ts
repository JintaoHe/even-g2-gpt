/** Defense in depth after protocol parsing: credential validation and dispatch
 * must use this same result, never separate presence tests. */
export function conversationAuthPath(message: Record<string, unknown>, protocolV2: boolean): 'master' | 'device' | 'resume' {
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  if (!protocolV2) {
    if (!text(message.token)) throw new Error('Auth');
    return 'master';
  }
  const supplied = ['token', 'device_credential', 'resume_credential'].filter(key => message[key] !== undefined);
  if (supplied.length !== 1) throw new Error('Auth');
  if (supplied[0] === 'resume_credential') {
    if (!text(message.resume_credential) || !text(message.resume_session_id)) throw new Error('Auth');
    return 'resume';
  }
  if (message.resume_session_id !== undefined || message.last_seen_sequence !== undefined) throw new Error('Auth');
  if (supplied[0] === 'device_credential') {
    if (!text(message.device_credential) || !['even_host_v1', 'browser_v1'].includes(String(message.credential_storage))) throw new Error('Auth');
    return 'device';
  }
  if (!text(message.token)) throw new Error('Auth');
  return 'master';
}
