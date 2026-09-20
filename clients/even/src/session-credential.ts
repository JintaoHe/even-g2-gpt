export type ResumeSessionCredential = {
  clientId: string;
  sessionId: string;
  secret: string;
  expiresAt: number;
};

export type DeviceCredential = {
  clientId: string;
  id: string;
  secret: string;
  expiresAt: number;
};

export type EvenHostStorage = {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
};

type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>;

const HOST_CLIENT_KEY = 'glass-assistant.client-id.v3';
const HOST_RESUME_KEY = 'glass-assistant.resume-credential.v3';
const HOST_DEVICE_KEY = 'glass-assistant.device-credential.v1';
const LEGACY_CLIENT_KEY = 'glass-assistant.client-id.v2';
const LEGACY_RESUME_KEY = 'glass-assistant.resume-credential.v2';
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

function parseCredential(raw: string | null | undefined, now: number) {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return validCredential(parsed, now) ? { ...parsed } : undefined;
  } catch {
    return undefined;
  }
}

function validDeviceCredential(value: unknown, now: number): value is DeviceCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['clientId', 'id', 'secret', 'expiresAt'].includes(key))
    && validUuid(item.clientId) && validUuid(item.id)
    && typeof item.secret === 'string' && item.secret.length >= 32 && item.secret.length <= 2048
    && Number.isSafeInteger(item.expiresAt) && Number(item.expiresAt) > now;
}

function parseDeviceCredential(raw: string | null | undefined, now: number) {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return validDeviceCredential(parsed, now) ? { ...parsed } : undefined;
  } catch {
    return undefined;
  }
}

type HostRead = { available: boolean; value?: string };

/**
 * Keeps only a stable client id and a short-lived, server-scoped resume
 * credential in the native Even App store. The long-lived application/master
 * token is deliberately not part of this API and remains memory-only.
 */
export class SessionCredentialStore {
  private readonly host: EvenHostStorage;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private initialized = false;
  private clientIdValue = '';
  private clientPersisted = false;
  private credentialValue?: ResumeSessionCredential;
  private deviceCredentialValue?: DeviceCredential;
  private persistenceHealthyValue = true;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(host: EvenHostStorage, now: () => number, uuid: () => string) {
    this.host = host;
    this.now = now;
    this.uuid = uuid;
  }

  static async open(
    host: EvenHostStorage,
    legacy?: LegacyStorage,
    now: () => number = Date.now,
    uuid: () => string = () => crypto.randomUUID(),
  ) {
    const store = new SessionCredentialStore(host, now, uuid);
    await store.initialize(legacy);
    return store;
  }

  get persistenceHealthy() { return this.persistenceHealthyValue; }

  /** Allows lifecycle/ACK code to wait until all host writes have settled. */
  whenSettled() { return this.writeQueue; }

  clientId() {
    this.assertInitialized();
    return this.clientIdValue;
  }

  load() {
    this.assertInitialized();
    if (this.credentialValue && !validCredential(this.credentialValue, this.now())) {
      void this.clearSession();
      return undefined;
    }
    return this.credentialValue ? { ...this.credentialValue } : undefined;
  }

  loadDevice() {
    this.assertInitialized();
    if (this.deviceCredentialValue && !validDeviceCredential(this.deviceCredentialValue, this.now())) {
      void this.clearDevice();
      return undefined;
    }
    return this.deviceCredentialValue ? { ...this.deviceCredentialValue } : undefined;
  }

  save(value: ResumeSessionCredential) {
    this.assertInitialized();
    if (!validCredential(value, this.now()) || value.clientId !== this.clientIdValue) {
      throw new Error('Invalid resume credential');
    }
    this.credentialValue = { ...value };
    return this.enqueueWrite(() => this.persistCredential(value));
  }

  clearSession() {
    this.assertInitialized();
    this.credentialValue = undefined;
    return this.enqueueWrite(() => this.write(HOST_RESUME_KEY, ''));
  }

  saveDevice(value: DeviceCredential) {
    this.assertInitialized();
    if (!validDeviceCredential(value, this.now()) || value.clientId !== this.clientIdValue) {
      throw new Error('Invalid device credential');
    }
    this.deviceCredentialValue = { ...value };
    return this.enqueueWrite(() => this.persistDeviceCredential(value));
  }

  clearDevice() {
    this.assertInitialized();
    this.deviceCredentialValue = undefined;
    return this.enqueueWrite(() => this.write(HOST_DEVICE_KEY, ''));
  }

  private async initialize(legacy?: LegacyStorage) {
    const [hostClientRead, hostResumeRead, hostDeviceRead] = await Promise.all([
      this.read(HOST_CLIENT_KEY), this.read(HOST_RESUME_KEY), this.read(HOST_DEVICE_KEY),
    ]);
    const legacyClient = this.legacyGet(legacy, LEGACY_CLIENT_KEY);
    const validHostClient = validUuid(hostClientRead.value) ? hostClientRead.value : undefined;
    const validLegacyClient = validUuid(legacyClient) ? legacyClient : undefined;
    const selectedClient = validHostClient ?? validLegacyClient ?? this.uuid();
    if (!validUuid(selectedClient)) throw new Error('Unable to create client identity');

    let clientPersisted = !!validHostClient;
    if (!clientPersisted && hostClientRead.available) {
      clientPersisted = await this.write(HOST_CLIENT_KEY, selectedClient);
    }
    this.clientIdValue = selectedClient;
    this.clientPersisted = clientPersisted;

    const hostCredential = parseCredential(hostResumeRead.value, this.now());
    if (hostCredential?.clientId === selectedClient) {
      this.credentialValue = hostCredential;
      if (legacy) {
        this.legacyRemove(legacy, LEGACY_CLIENT_KEY);
        this.legacyRemove(legacy, LEGACY_RESUME_KEY);
      }
    } else {
      if (hostResumeRead.value && hostResumeRead.available) await this.write(HOST_RESUME_KEY, '');
      const legacyCredential = parseCredential(this.legacyGet(legacy, LEGACY_RESUME_KEY), this.now());
      if (legacyCredential?.clientId === selectedClient) {
        // Preserve continuity during a transient host-storage failure, but never
        // write new credentials back to browser storage.
        this.credentialValue = legacyCredential;
        if (clientPersisted && hostResumeRead.available) {
          const migrated = await this.write(HOST_RESUME_KEY, JSON.stringify(legacyCredential));
          if (migrated && legacy) {
            this.legacyRemove(legacy, LEGACY_CLIENT_KEY);
            this.legacyRemove(legacy, LEGACY_RESUME_KEY);
          }
        }
      } else if (legacy) {
        this.legacyRemove(legacy, LEGACY_RESUME_KEY);
        if (clientPersisted) this.legacyRemove(legacy, LEGACY_CLIENT_KEY);
      }
    }

    if (validHostClient && legacy) this.legacyRemove(legacy, LEGACY_CLIENT_KEY);
    const hostDeviceCredential = parseDeviceCredential(hostDeviceRead.value, this.now());
    if (hostDeviceCredential?.clientId === selectedClient) this.deviceCredentialValue = hostDeviceCredential;
    else if (hostDeviceRead.value && hostDeviceRead.available) await this.write(HOST_DEVICE_KEY, '');
    this.initialized = true;
  }

  private async persistCredential(value: ResumeSessionCredential) {
    if (!this.clientPersisted) {
      this.clientPersisted = await this.write(HOST_CLIENT_KEY, this.clientIdValue);
      if (!this.clientPersisted) return false;
    }
    return this.write(HOST_RESUME_KEY, JSON.stringify(value));
  }

  private async persistDeviceCredential(value: DeviceCredential) {
    if (!this.clientPersisted) {
      this.clientPersisted = await this.write(HOST_CLIENT_KEY, this.clientIdValue);
      if (!this.clientPersisted) return false;
    }
    return this.write(HOST_DEVICE_KEY, JSON.stringify(value));
  }

  private enqueueWrite(operation: () => Promise<boolean>) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertInitialized() {
    if (!this.initialized) throw new Error('Session credential store is not initialized');
  }

  private async read(key: string): Promise<HostRead> {
    try {
      const value = await this.host.getLocalStorage(key);
      return { available: true, value: typeof value === 'string' ? value : '' };
    } catch {
      this.persistenceHealthyValue = false;
      return { available: false };
    }
  }

  private async write(key: string, value: string) {
    try {
      const saved = await this.host.setLocalStorage(key, value);
      if (saved !== true) this.persistenceHealthyValue = false;
      return saved === true;
    } catch {
      this.persistenceHealthyValue = false;
      return false;
    }
  }

  private legacyGet(legacy: LegacyStorage | undefined, key: string) {
    if (!legacy) return null;
    try { return legacy.getItem(key); }
    catch { return null; }
  }

  private legacyRemove(legacy: LegacyStorage, key: string) {
    try { legacy.removeItem(key); }
    catch { /* A failed cleanup is retried on the next cold start. */ }
  }
}

export const sessionCredentialStorageKeys = {
  client: HOST_CLIENT_KEY,
  resume: HOST_RESUME_KEY,
  device: HOST_DEVICE_KEY,
  legacyClient: LEGACY_CLIENT_KEY,
  legacyResume: LEGACY_RESUME_KEY,
} as const;
