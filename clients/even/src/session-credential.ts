export type ResumeSessionCredential = {
  clientId: string;
  sessionId: string;
  secret: string;
  expiresAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const CLIENT_KEY = 'glass-assistant.client-id.v2';
const RESUME_KEY = 'glass-assistant.resume-credential.v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function validCredential(value: unknown, now: number): value is ResumeSessionCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['clientId', 'sessionId', 'secret', 'expiresAt'].includes(key))
    && validUuid(item.clientId) && validUuid(item.sessionId)
    && typeof item.secret === 'string' && item.secret.length >= 32 && item.secret.length <= 2048
    && Number.isSafeInteger(item.expiresAt) && Number(item.expiresAt) > now;
}

/** Browser storage is intentionally limited to the short-lived, server-scoped
 * resume credential. The long-lived G2 access token is never accepted here. */
export class SessionCredentialStore {
  private readonly storage: StorageLike;
  private readonly now: () => number;
  private readonly uuid: () => string;
  constructor(
    storage: StorageLike,
    now: () => number = Date.now,
    uuid: () => string = () => crypto.randomUUID(),
  ) {
    this.storage = storage;
    this.now = now;
    this.uuid = uuid;
  }

  clientId() {
    try {
      const current = this.storage.getItem(CLIENT_KEY);
      if (validUuid(current)) return current;
      const created = this.uuid();
      if (!validUuid(created)) throw new Error('Invalid UUID source');
      this.storage.setItem(CLIENT_KEY, created);
      return created;
    } catch {
      const fallback = this.uuid();
      if (!validUuid(fallback)) throw new Error('Unable to create client identity');
      return fallback;
    }
  }

  load() {
    try {
      const raw = this.storage.getItem(RESUME_KEY);
      if (!raw) return undefined;
      const parsed: unknown = JSON.parse(raw);
      if (!validCredential(parsed, this.now())) {
        this.storage.removeItem(RESUME_KEY);
        return undefined;
      }
      return { ...parsed };
    } catch {
      try { this.storage.removeItem(RESUME_KEY); } catch { /* unavailable storage */ }
      return undefined;
    }
  }

  save(value: ResumeSessionCredential) {
    if (!validCredential(value, this.now())) throw new Error('Invalid resume credential');
    this.storage.setItem(RESUME_KEY, JSON.stringify(value));
  }

  clearSession() {
    try { this.storage.removeItem(RESUME_KEY); } catch { /* unavailable storage */ }
  }
}

export const sessionCredentialStorageKeys = { client: CLIENT_KEY, resume: RESUME_KEY } as const;
