import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, rename, lstat, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Message } from './conversation.js';
import type { MailSender } from './mail.js';
import { renderDocument, type Document, type Presentation } from './document-presentation.js';
import { validateCalendar, type CalendarEvent } from './calendar.js';

export type Job = { id: string; state: string; created: string; updated: string; error: string | null; bytes: number; mail_state?: string | null; title?: string; filename?: string; calendar?: CalendarEvent; superseded?: boolean };
const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 50 * 1024 * 1024;
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);

/** Single-host/single-worker durable MD export queue. Never stores auth credentials. */
export class JobStore {
  private busy?: Promise<void>;
  private closing = false;
  private controller?: AbortController;
  private active?: string;
  private scheduled?: NodeJS.Immediate;
  private closePromise?: Promise<void>;
  private mailing?: Promise<void>;
  private constructor(private db: DatabaseSync, private directory: string, private owner: string,
    private render: (history: Message[], signal: AbortSignal) => Promise<string | Document>) {}

  static async create(directory: string, render: (history: Message[], signal: AbortSignal) => Promise<string | Document> = async (history, signal) => {
    signal.throwIfAborted(); return renderDocument(history);
  }) {
    const root = resolve(directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Data root cannot be a symlink');
    const artifacts = join(root, 'artifacts');
    await mkdir(artifacts, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    if ((await lstat(artifacts)).isSymbolicLink()) throw new Error('Artifact directory cannot be a symlink');
    const dbPath = join(root, 'jobs.sqlite');
    const existing = await lstat(dbPath).catch(e => { if (e.code !== 'ENOENT') throw e; return undefined; });
    if (existing?.isSymbolicLink()) throw new Error('Database cannot be a symlink');
    const db = new DatabaseSync(dbPath), owner = randomUUID();
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS service_owner (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, pid INTEGER, host TEXT);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, created TEXT NOT NULL,
          updated TEXT NOT NULL, error TEXT, bytes INTEGER NOT NULL DEFAULT 0, input TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mail_deliveries (job_id TEXT PRIMARY KEY, state TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS artifact_metadata (job_id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS calendar_events (job_id TEXT PRIMARY KEY, event TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS superseded_artifacts (job_id TEXT PRIMARY KEY);`);
      db.exec('BEGIN IMMEDIATE');
      const prior = db.prepare('SELECT * FROM service_owner WHERE id=1').get() as any;
      if (prior) {
        if (prior.host !== hostname()) throw new Error('Data directory belongs to another host');
        let alive = true;
        try { process.kill(prior.pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another service owns this data directory');
      }
      db.prepare('INSERT OR REPLACE INTO service_owner VALUES (1,?,?,?)').run(owner, process.pid, hostname());
      // Never replay a task that may already have produced output before a crash.
      db.prepare("UPDATE jobs SET state='interrupted',error='SERVICE_RESTARTED',input='[]',updated=? WHERE state='running'").run(new Date().toISOString());
      db.exec("UPDATE mail_deliveries SET state='unknown' WHERE state='sending'");
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
    const store = new JobStore(db, artifacts, owner, render);
    store.kick(); return store;
  }

  list(): Job[] {
    const jobs = this.db.prepare('SELECT j.id,j.state,j.created,j.updated,j.error,j.bytes,m.state AS mail_state FROM jobs j LEFT JOIN mail_deliveries m ON j.id=m.job_id ORDER BY j.created DESC LIMIT 100').all() as unknown as Job[];
    return jobs.map(job => { const metadata = this.metadata(job.id); return { ...job, title: metadata?.title, filename: metadata?.filename, calendar: this.calendar(job.id), superseded: this.superseded(job.id) }; });
  }
  superseded(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM superseded_artifacts WHERE job_id=?').get(id); }
  supersede(id: string) { if (this.get(id)) this.db.prepare('INSERT OR IGNORE INTO superseded_artifacts VALUES (?)').run(id); }
  calendar(id: string): CalendarEvent | undefined {
    const row = this.db.prepare('SELECT event FROM calendar_events WHERE job_id=?').get(id) as { event: string } | undefined;
    return row ? validateCalendar(JSON.parse(row.event)) : undefined;
  }
  mailState(id: string): string | undefined {
    return (this.db.prepare('SELECT state FROM mail_deliveries WHERE job_id=?').get(id) as { state: string } | undefined)?.state;
  }
  metadata(id: string): Presentation | undefined {
    const row = this.db.prepare('SELECT metadata FROM artifact_metadata WHERE job_id=?').get(id) as { metadata: string } | undefined;
    return row ? JSON.parse(row.metadata) : undefined;
  }
  async email(id: string, sender: MailSender, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.closing) throw new Error('MAIL_STOPPING');
    if (this.superseded(id)) throw new Error('MAIL_SUPERSEDED');
    const prior = this.mailState(id);
    if (prior) return prior; // One attempt per artifact, even across service restarts.
    if (this.mailing) throw new Error('MAIL_BUSY');
    const bytes = await this.download(id);
    signal?.throwIfAborted();
    if (this.superseded(id)) throw new Error('MAIL_SUPERSEDED');
    // Recheck after asynchronous I/O so simultaneous clicks cannot duplicate delivery.
    if (this.closing || this.mailing) throw new Error('MAIL_BUSY');
    const existing = this.mailState(id); if (existing) return existing;
    const date = new Date().toISOString();
    const count = this.db.prepare('SELECT COUNT(*) AS total FROM mail_deliveries WHERE created>=?').get(date.slice(0, 10)) as { total: number };
    if (count.total >= 20) throw new Error('MAIL_DAILY_LIMIT');
    this.db.prepare("INSERT INTO mail_deliveries VALUES (?,'sending',?)").run(id, date);
    const operation = Promise.resolve().then(() => sender(id, bytes, this.metadata(id), this.calendar(id), this.get(id)!.created)).then(result => {
      this.db.prepare('UPDATE mail_deliveries SET state=? WHERE job_id=?').run(result, id);
    }).catch(() => {
      this.db.prepare("UPDATE mail_deliveries SET state='unknown' WHERE job_id=?").run(id);
    }).finally(() => { this.mailing = undefined; });
    this.mailing = operation;
    await operation; return this.mailState(id)!;
  }
  get(id: string): Job | undefined {
    if (!validId(id)) return undefined;
    return this.db.prepare('SELECT id,state,created,updated,error,bytes FROM jobs WHERE id=?').get(id) as Job | undefined;
  }
  enqueue(history: Message[], calendar?: unknown): Job {
    if (!history.length || history.length > 100 || history.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new Error('Invalid conversation snapshot');
    return this.enqueueInput(JSON.stringify(history), calendar);
  }
  enqueueDocument(document: Document, calendar?: unknown): Job {
    if (!document.markdown.trim() || !document.presentation.title || !document.presentation.summary) throw new Error('Invalid document');
    return this.enqueueInput(JSON.stringify({ document }), calendar);
  }
  private enqueueInput(input: string, calendar?: unknown): Job {
    if (this.closing) throw new Error('Service stopping');
    if (Buffer.byteLength(input) > MAX_FILE) throw new Error('Input too large');
    const count = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN state IN ('queued','running') THEN 1 ELSE 0 END) AS pending FROM jobs").get() as any;
    if (count.total >= 1000 || count.pending >= 20) throw new Error('Job capacity reached');
    const id = randomUUID(), now = new Date().toISOString();
    const event = calendar === undefined ? undefined : validateCalendar(calendar);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO jobs VALUES (?,'queued',?,?,NULL,0,?)").run(id, now, now, input);
      if (event) this.db.prepare('INSERT INTO calendar_events VALUES (?,?)').run(id, JSON.stringify(event));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.kick(); return this.get(id)!;
  }
  cancel(id: string) {
    const job = this.get(id);
    if (!job || !['queued', 'running'].includes(job.state)) return;
    this.db.prepare("UPDATE jobs SET state='cancelled',updated=?,input='[]' WHERE id=?").run(new Date().toISOString(), id);
    if (id === this.active) this.controller?.abort();
  }
  private kick() {
    if (this.closing || this.busy || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.busy = this.drain().catch(() => { this.closing = true; }).finally(() => {
        this.busy = undefined;
        if (!this.closing && this.db.prepare("SELECT 1 FROM jobs WHERE state='queued' LIMIT 1").get()) this.kick();
      });
    });
  }
  private async drain() {
    while (!this.closing) {
      const next = this.db.prepare("SELECT id,input FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").get() as any;
      if (!next) return;
      this.active = next.id; const controller = this.controller = new AbortController();
      this.db.prepare("UPDATE jobs SET state='running',updated=? WHERE id=?").run(new Date().toISOString(), next.id);
      try {
        const input = JSON.parse(next.input);
        const rendered: string | Document = Array.isArray(input) ? await this.render(input, controller.signal) : input.document;
        const markdown = typeof rendered === 'string' ? rendered : rendered.markdown;
        controller.signal.throwIfAborted();
        const bytes = Buffer.byteLength(markdown);
        let used = 0;
        for (const entry of await readdir(this.directory)) {
          const stat = await lstat(join(this.directory, entry));
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid artifact directory');
          used += stat.size; // Include unpublished/partial files left by interrupted writes.
        }
        if (!bytes || bytes > MAX_FILE || used + bytes > MAX_TOTAL) throw new Error('Artifact limit');
        const temporary = join(this.directory, `${next.id}.part`), target = join(this.directory, `${next.id}.md`);
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(markdown, 'utf8'); await file.sync(); } finally { await file.close(); }
        controller.signal.throwIfAborted();
        await rename(temporary, target);
        if (process.platform !== 'win32') { const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
        controller.signal.throwIfAborted();
        this.db.exec('BEGIN IMMEDIATE');
        try {
          if (typeof rendered !== 'string') this.db.prepare('INSERT OR REPLACE INTO artifact_metadata VALUES (?,?)').run(next.id, JSON.stringify(rendered.presentation));
          this.db.prepare("UPDATE jobs SET state='completed',bytes=?,input='[]',updated=? WHERE id=?").run(bytes, new Date().toISOString(), next.id);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      } catch {
        const current = this.get(next.id);
        if (current?.state === 'running') this.db.prepare("UPDATE jobs SET state=?,error=?,input='[]',updated=? WHERE id=?").run(
          this.closing ? 'interrupted' : 'failed', this.closing ? 'SERVICE_STOPPED' : 'EXPORT_FAILED', new Date().toISOString(), next.id);
      } finally { this.active = undefined; this.controller = undefined; }
    }
  }
  async download(id: string) {
    const job = this.get(id);
    if (job?.state !== 'completed') throw new Error('Artifact unavailable');
    const path = join(this.directory, `${id}.md`), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== job.bytes || info.size > MAX_FILE) throw new Error('Invalid artifact');
    return readFile(path);
  }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closing = true;
      if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = undefined; }
      this.controller?.abort(); await Promise.all([this.busy, this.mailing]);
      this.db.prepare('DELETE FROM service_owner WHERE id=1 AND token=?').run(this.owner);
      this.db.close();
    })();
  }
}
