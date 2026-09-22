import { ProtocolValidationError } from './conversation-protocol.js';

/** Deliberately separate until both server dispatch and client clearing are
 * enabled together. Parsing is not authentication or permission to switch. */
export type GuestModeCommand = { type: 'guest.enter'; command_id: string }
  | { type: 'guest.unlock.begin'; command_id: string }
  | { type: 'guest.unlock.confirm'; command_id: string; challenge: string; owner_token: string };

export function parseGuestModeCommand(input: unknown): GuestModeCommand {
  const invalid = (): never => { throw new ProtocolValidationError(); };
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
  const value = input as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) return invalid();
  const type = value.type;
  if (typeof type !== 'string' || !['guest.enter', 'guest.unlock.begin', 'guest.unlock.confirm'].includes(type)
    || typeof value.command_id !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.command_id)) return invalid();
  const keys = type === 'guest.unlock.confirm' ? ['type', 'command_id', 'challenge', 'owner_token'] : ['type', 'command_id'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) return invalid();
  if (type === 'guest.unlock.confirm') {
    if (typeof value.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.challenge)
      || typeof value.owner_token !== 'string' || value.owner_token.length < 32 || value.owner_token.length > 2048) return invalid();
    return { type, command_id: value.command_id, challenge: value.challenge, owner_token: value.owner_token };
  }
  return { type: type as 'guest.enter' | 'guest.unlock.begin', command_id: value.command_id };
}
