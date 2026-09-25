import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { replaceLedgerFile } from './atomic-ledger-rename.js';
import { dirname, resolve } from 'node:path';

export type CostProvider = 'openai' | 'soniox' | 'google';
export type GoogleSku = 'places-text-search-enterprise' | 'places-details-enterprise' | 'route-matrix-pro' | 'route-matrix-essentials'
  | 'time-zone' | 'geocoding' | 'weather' | 'air-quality' | 'pollen';

export type CostAlert = {
  period: string;
  sku: GoogleSku;
  label: string;
  units: number;
  freeUnits: number;
  threshold: number;
};

export type CostAlertSender = (alert: CostAlert) => Promise<'accepted' | 'failed' | 'unknown'>;

type AlertState = 'pending' | 'sending' | 'sent';
type MonthRecord = {
  providerNanoUsd: Record<CostProvider, number>;
  googleUnits: Partial<Record<GoogleSku, number>>;
  alerts: Record<string, AlertState>;
};
type LedgerFile = { version: 1; months: Record<string, MonthRecord> };

export type CostSnapshot = {
  period: string;
  providerUsd: Record<CostProvider, number>;
  totalUsd: number;
  limitsUsd: { total: number } & Record<CostProvider, number>;
  googleUnits: Partial<Record<GoogleSku, number>>;
};

type SkuDefinition = { label: string; freeUnits: number; usdPerThousand: number; thresholds: number[] };
export const GOOGLE_SKUS: Record<GoogleSku, SkuDefinition> = {
  geocoding: { label: 'Geocoding', freeUnits: 10_000, usdPerThousand: 5, thresholds: [95] },
  'places-details-enterprise': { label: 'Places Details Enterprise', freeUnits: 1_000, usdPerThousand: 20, thresholds: [50, 95] },
  'places-text-search-enterprise': { label: 'Places Text Search Enterprise', freeUnits: 1_000, usdPerThousand: 35, thresholds: [50, 95] },
  'route-matrix-pro': { label: 'Routes Compute Route Matrix Pro', freeUnits: 5_000, usdPerThousand: 10, thresholds: [95] },
  'route-matrix-essentials': { label: 'Routes Compute Route Matrix Essentials', freeUnits: 10_000, usdPerThousand: 5, thresholds: [95] },
  'time-zone': { label: 'Time Zone', freeUnits: 10_000, usdPerThousand: 5, thresholds: [95] },
  weather: { label: 'Weather', freeUnits: 10_000, usdPerThousand: 0.15, thresholds: [95] },
  'air-quality': { label: 'Air Quality', freeUnits: 10_000, usdPerThousand: 5, thresholds: [95] },
  pollen: { label: 'Pollen', freeUnits: 5_000, usdPerThousand: 10, thresholds: [95] }
};

const NANO_USD = 1_000_000_000;
const dollarsToNano = (value: number) => Math.round(value * NANO_USD);
const nanoToDollars = (value: number) => value / NANO_USD;
const blankMonth = (): MonthRecord => ({
  providerNanoUsd: { openai: 0, soniox: 0, google: 0 }, googleUnits: {}, alerts: {}
});
const finitePositive = (value: string | undefined, fallback: number, name: string) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
};

export interface CostReservation {
  readonly reservedUsd: number;
  settle(actualUsd: number): Promise<void>;
}
export interface GoogleReservation {
  settle(actualUnits: number): Promise<void>;
}

export class CostBudgetExceeded extends Error {
  constructor(public provider: CostProvider) { super('COST_BUDGET_EXHAUSTED'); }
}

export class CostLedger {
  private queue = Promise.resolve();
  private persistenceFailed = false;
  private flushing = false;
  private alertRetry?: NodeJS.Timeout;
  private readonly limitsNano: Record<CostProvider, number> & { total: number };

  private constructor(private file: string, private data: LedgerFile, private alertSender?: CostAlertSender,
    private now: () => Date = () => new Date(), private timezone = 'America/Los_Angeles', limits?: Record<CostProvider, number> & { total: number }) {
    this.limitsNano = {
      openai: dollarsToNano(limits?.openai ?? 50), soniox: dollarsToNano(limits?.soniox ?? 20),
      google: dollarsToNano(limits?.google ?? 10), total: dollarsToNano(limits?.total ?? 80)
    };
  }

  static async create(file: string, env: NodeJS.ProcessEnv = process.env, alertSender?: CostAlertSender,
    options: { now?: () => Date; timezone?: string } = {}) {
    const limits = {
      openai: finitePositive(env.COST_OPENAI_MONTHLY_USD, 50, 'COST_OPENAI_MONTHLY_USD'),
      soniox: finitePositive(env.COST_SONIOX_MONTHLY_USD, 20, 'COST_SONIOX_MONTHLY_USD'),
      google: finitePositive(env.COST_GOOGLE_MONTHLY_USD, 10, 'COST_GOOGLE_MONTHLY_USD'),
      total: finitePositive(env.COST_TOTAL_MONTHLY_USD, 80, 'COST_TOTAL_MONTHLY_USD')
    };
    if (limits.openai + limits.soniox + limits.google > limits.total) throw new Error('Provider cost limits exceed COST_TOTAL_MONTHLY_USD');
    let data: LedgerFile = { version: 1, months: {} };
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as LedgerFile;
      if (parsed?.version !== 1 || !parsed.months || typeof parsed.months !== 'object') throw new Error('invalid');
      for (const month of Object.values(parsed.months)) {
        if (!month?.providerNanoUsd || !month.googleUnits || !month.alerts) throw new Error('invalid');
        for (const state of Object.values(month.alerts)) if (!['pending', 'sending', 'sent'].includes(state)) throw new Error('invalid');
        for (const key of ['openai', 'soniox', 'google'] as const) {
          if (!Number.isSafeInteger(month.providerNanoUsd[key]) || month.providerNanoUsd[key] < 0) throw new Error('invalid');
        }
        for (const [sku, units] of Object.entries(month.googleUnits)) {
          if (!(sku in GOOGLE_SKUS) || !Number.isSafeInteger(units) || units < 0) throw new Error('invalid');
        }
        for (const [key, state] of Object.entries(month.alerts)) if (state === 'sending') month.alerts[key] = 'pending';
      }
      data = parsed;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error('COST_LEDGER_INVALID');
    }
    const ledger = new CostLedger(resolve(file), data, alertSender, options.now, options.timezone, limits);
    await ledger.mutate(() => {});
    void ledger.flushAlerts();
    return ledger;
  }

  private period(date = this.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit' }).formatToParts(date);
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${value.year}-${value.month}`;
  }
  private month(period = this.period()) { return this.data.months[period] ??= blankMonth(); }
  private total(month: MonthRecord) { return month.providerNanoUsd.openai + month.providerNanoUsd.soniox + month.providerNanoUsd.google; }
  private async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await replaceLedgerFile(temporary, this.file);
    try { const handle = await open(this.file, 'r+'); await handle.chmod(0o600); await handle.close(); } catch { /* Windows may not expose POSIX mode bits. */ }
  }
  private mutate<T>(operation: () => T | Promise<T>) {
    const next = this.queue.catch(() => {}).then(async () => {
      if (this.persistenceFailed) throw new Error('COST_LEDGER_UNAVAILABLE');
      const value = await operation();
      try { await this.persist(); } catch { this.persistenceFailed = true; throw new Error('COST_LEDGER_UNAVAILABLE'); }
      return value;
    });
    this.queue = next.then(() => {}, () => {}); return next;
  }

  async reserve(provider: CostProvider, maximumUsd: number): Promise<CostReservation> {
    if (!Number.isFinite(maximumUsd) || maximumUsd <= 0) throw new Error('COST_RESERVATION_INVALID');
    const nano = Math.max(1, dollarsToNano(maximumUsd));
    const { period } = await this.mutate(() => {
      const period = this.period(), month = this.month(period);
      if (month.providerNanoUsd[provider] + nano > this.limitsNano[provider] || this.total(month) + nano > this.limitsNano.total) {
        throw new CostBudgetExceeded(provider);
      }
      month.providerNanoUsd[provider] += nano;
      return { period };
    });
    let settled = false;
    return { reservedUsd: nanoToDollars(nano), settle: async actualUsd => {
      if (settled) return;
      if (!Number.isFinite(actualUsd) || actualUsd < 0 || dollarsToNano(actualUsd) > nano) throw new Error('COST_SETTLEMENT_INVALID');
      settled = true;
      await this.mutate(() => {
        const month = this.data.months[period];
        if (!month) throw new Error('COST_PERIOD_MISSING');
        month.providerNanoUsd[provider] = Math.max(0, month.providerNanoUsd[provider] - nano + dollarsToNano(actualUsd));
      });
    } };
  }

  canReserve(provider: CostProvider, maximumUsd: number): boolean {
    if (this.persistenceFailed || !Number.isFinite(maximumUsd) || maximumUsd <= 0) return false;
    const nano = Math.max(1, dollarsToNano(maximumUsd));
    const month = this.data.months[this.period()] ?? blankMonth();
    return month.providerNanoUsd[provider] + nano <= this.limitsNano[provider]
      && this.total(month) + nano <= this.limitsNano.total;
  }

  async reserveGoogle(sku: GoogleSku, units: number): Promise<GoogleReservation> {
    if (!Number.isSafeInteger(units) || units < 1) throw new Error('GOOGLE_UNITS_INVALID');
    const definition = GOOGLE_SKUS[sku];
    const { period, reservedNano } = await this.mutate(() => {
      const period = this.period(), month = this.month(period), before = month.googleUnits[sku] ?? 0, after = before + units;
      const paidBefore = Math.max(0, before - definition.freeUnits), paidAfter = Math.max(0, after - definition.freeUnits);
      const reservedNano = dollarsToNano((paidAfter - paidBefore) * definition.usdPerThousand / 1000);
      if (month.providerNanoUsd.google + reservedNano > this.limitsNano.google || this.total(month) + reservedNano > this.limitsNano.total) {
        throw new CostBudgetExceeded('google');
      }
      month.googleUnits[sku] = after;
      month.providerNanoUsd.google += reservedNano;
      return { period, reservedNano };
    });
    let settled = false;
    return { settle: async actualUnits => {
      if (settled) return;
      if (!Number.isSafeInteger(actualUnits) || actualUnits < 0 || actualUnits > units) throw new Error('GOOGLE_SETTLEMENT_INVALID');
      settled = true;
      const alerts = await this.mutate(() => {
        const month = this.data.months[period];
        if (!month) throw new Error('COST_PERIOD_MISSING');
        const current = month.googleUnits[sku] ?? units;
        const final = Math.max(0, current - (units - actualUnits));
        const paidCurrent = Math.max(0, current - definition.freeUnits), paidFinal = Math.max(0, final - definition.freeUnits);
        const releasedNano = dollarsToNano((paidCurrent - paidFinal) * definition.usdPerThousand / 1000);
        month.googleUnits[sku] = final;
        month.providerNanoUsd.google = Math.max(0, month.providerNanoUsd.google - Math.min(reservedNano, releasedNano));
        const queued: CostAlert[] = [];
        for (const threshold of definition.thresholds) {
          if (final * 100 < definition.freeUnits * threshold) continue;
          const key = `${sku}:${threshold}`;
          if (month.alerts[key]) continue;
          month.alerts[key] = 'pending';
          queued.push({ period, sku, label: definition.label, units: final, freeUnits: definition.freeUnits, threshold });
        }
        return queued;
      });
      if (alerts.length) void this.flushAlerts();
    } };
  }

  async snapshot(): Promise<CostSnapshot> {
    await this.queue;
    const period = this.period(), month = this.month(period);
    return { period, providerUsd: {
      openai: nanoToDollars(month.providerNanoUsd.openai), soniox: nanoToDollars(month.providerNanoUsd.soniox), google: nanoToDollars(month.providerNanoUsd.google)
    }, totalUsd: nanoToDollars(this.total(month)), limitsUsd: {
      openai: nanoToDollars(this.limitsNano.openai), soniox: nanoToDollars(this.limitsNano.soniox),
      google: nanoToDollars(this.limitsNano.google), total: nanoToDollars(this.limitsNano.total)
    }, googleUnits: { ...month.googleUnits } };
  }

  async flushAlerts() {
    if (!this.alertSender || this.flushing) return;
    if (this.alertRetry) { clearTimeout(this.alertRetry); this.alertRetry = undefined; }
    this.flushing = true;
    let retry = false;
    try {
      while (true) {
        const selected = await this.mutate(() => {
          for (const [period, month] of Object.entries(this.data.months).sort()) {
            const entry = Object.entries(month.alerts).find(([, state]) => state === 'pending');
            if (!entry) continue;
            const [key] = entry, split = key.lastIndexOf(':'), sku = key.slice(0, split) as GoogleSku, threshold = Number(key.slice(split + 1));
            const definition = GOOGLE_SKUS[sku];
            if (!definition || !definition.thresholds.includes(threshold)) { month.alerts[key] = 'sent'; continue; }
            month.alerts[key] = 'sending';
            return { key, alert: { period, sku, label: definition.label, units: month.googleUnits[sku] ?? 0,
              freeUnits: definition.freeUnits, threshold } satisfies CostAlert };
          }
          return undefined;
        });
        if (!selected) break;
        const result = await this.alertSender(selected.alert).catch(() => 'unknown' as const);
        await this.mutate(() => {
          const month = this.data.months[selected.alert.period];
          if (month) month.alerts[selected.key] = result === 'accepted' ? 'sent' : 'pending';
        });
        if (result !== 'accepted') { retry = true; break; }
      }
    } finally {
      this.flushing = false;
      if (retry && !this.alertRetry) {
        this.alertRetry = setTimeout(() => { this.alertRetry = undefined; void this.flushAlerts(); }, 15 * 60_000);
        this.alertRetry.unref();
      }
    }
  }
}
