import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface SearchTicket { limit: number; settle(actual: number): Promise<void> }
export interface SearchBudget { reserve(requested: number): Promise<SearchTicket | null> }
type Ledger = { version: 1; days: Record<string, number>; months: Record<string, number> };
const queues = new Map<string, Promise<unknown>>();

/** Single-process ledger. Outstanding reservations stay charged after crashes. */
export class SearchQuota implements SearchBudget {
  private path: string;
  constructor(path = '.local/search-usage.json', private timezone = 'America/Chicago',
    private daily = 20, private monthly = 600, private clock = () => new Date()) {
    this.path = resolve(path);
    if (![daily, monthly].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid quota');
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const task = (queues.get(this.path) ?? Promise.resolve()).catch(() => {}).then(run);
    queues.set(this.path, task); return task;
  }
  private async read(): Promise<Ledger> {
    let data: any;
    try { data = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, days: {}, months: {} };
      throw e;
    }
    if (data?.version !== 1) throw new Error('Invalid quota ledger');
    for (const [key, pattern] of [['days', /^\d{4}-\d{2}-\d{2}$/], ['months', /^\d{4}-\d{2}$/]] as const) {
      const values = data[key];
      if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.entries(values).some(([date, n]) => !pattern.test(date) || !Number.isSafeInteger(n) || (n as number) < 0))
        throw new Error('Invalid quota ledger');
    }
    return data;
  }
  private async write(data: Ledger) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path + '.tmp', JSON.stringify(data), { mode: 0o600 });
    await rename(this.path + '.tmp', this.path);
  }
  reserve(requested: number): Promise<SearchTicket | null> {
    if (!Number.isSafeInteger(requested) || requested < 1) return Promise.reject(new Error('Invalid reservation'));
    return this.serial(async () => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(this.clock());
      const part = (type: string) => parts.find(p => p.type === type)!.value;
      const month = `${part('year')}-${part('month')}`, day = `${month}-${part('day')}`;
      const data = await this.read();
      const limit = Math.min(requested, this.daily - (data.days[day] ?? 0), this.monthly - (data.months[month] ?? 0));
      if (limit <= 0) return null;
      data.days[day] = (data.days[day] ?? 0) + limit;
      data.months[month] = (data.months[month] ?? 0) + limit;
      await this.write(data);
      let settled = false;
      return { limit, settle: (actual: number) => this.serial(async () => {
        if (!Number.isSafeInteger(actual) || actual < 0 || actual > limit) throw new Error('Invalid search usage');
        if (settled) return;
        const current = await this.read();
        if ((current.days[day] ?? 0) < limit || (current.months[month] ?? 0) < limit) throw new Error('Quota ledger changed');
        current.days[day] -= limit - actual; current.months[month] -= limit - actual;
        await this.write(current); settled = true;
      }) };
    });
  }
}
