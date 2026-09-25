import { AppLocationAccuracy, type AppLocation, type AppLocationOptions } from '@evenrealities/even_hub_sdk';

export type LocationMode = 'once' | 'continuous';
export type LocationReport = {
  type: 'location.report';
  mode: LocationMode;
  request_id?: string;
  location: { latitude: number; longitude: number; accuracy?: number; timestamp?: number; timezone_hint?: string };
};

type LocationBridge = {
  getAppLocation(options?: AppLocationOptions): Promise<AppLocation | null>;
  startAppLocationUpdates(options?: AppLocationOptions): Promise<boolean>;
  stopAppLocationUpdates(): Promise<boolean>;
  onAppLocationChanged(callback: (location: AppLocation) => void): () => void;
};

export function locationReport(mode: LocationMode, value: AppLocation, requestId?: string, timezoneHint?: string): LocationReport | undefined {
  if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90
    || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) return undefined;
  const accuracy = value.accuracy;
  const timestamp = value.timestamp;
  if (accuracy !== undefined && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10_000)) return undefined;
  if (timestamp !== undefined && (!Number.isFinite(timestamp) || timestamp <= 0)) return undefined;
  if (timezoneHint !== undefined) {
    try { timezoneHint = new Intl.DateTimeFormat('en', { timeZone: timezoneHint }).resolvedOptions().timeZone; }
    catch { return undefined; }
  }
  return { type: 'location.report', mode, ...(requestId ? { request_id: requestId } : {}), location: {
    latitude: value.latitude, longitude: value.longitude,
    ...(accuracy === undefined ? {} : { accuracy }), ...(timestamp === undefined ? {} : { timestamp }),
    ...(timezoneHint === undefined ? {} : { timezone_hint: timezoneHint })
  } };
}

export class LocationController {
  private unsubscribe?: () => void;
  private active = false;
  private bridge: LocationBridge;
  private report: (value: LocationReport) => void;
  private automaticGeneration = 0;
  private onceGeneration = 0;
  private pause: (ms: number) => Promise<void>;
  private timezoneHint: () => string | undefined;
  private now: () => number;
  private lastContinuousReportAt = 0;
  constructor(bridge: LocationBridge, report: (value: LocationReport) => void,
    pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    timezoneHint: () => string | undefined = () => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
    }, now: () => number = Date.now) {
    this.bridge = bridge;
    this.report = report;
    this.pause = pause;
    this.timezoneHint = timezoneHint;
    this.now = now;
  }

  async once(current: () => boolean = () => true) {
    const generation = ++this.onceGeneration;
    const value = await this.bridge.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: 10_000 });
    if (generation !== this.onceGeneration || !current()) return false;
    const report = value && locationReport('once', value, undefined, this.timezoneHint());
    if (report) this.report(report);
    return !!report;
  }

  async automatic(requestId: string, attempts: { accuracy: 'high' | 'medium'; timeout_ms: number }[], maximumAccuracyM: number,
    onAttempt: (attempt: number, total: number) => void) {
    if (!/^[a-f0-9-]{36}$/.test(requestId) || attempts.length < 1 || attempts.length > 3
      || !Number.isFinite(maximumAccuracyM) || maximumAccuracyM < 1 || maximumAccuracyM > 1000) return { ok: false as const, reason: 'unavailable' as const };
    const generation = ++this.automaticGeneration;
    let lowAccuracy = false;
    for (let index = 0; index < attempts.length; index++) {
      if (generation !== this.automaticGeneration) return { ok: false as const, reason: 'cancelled' as const };
      const attempt = attempts[index]; onAttempt(index + 1, attempts.length);
      const accuracy = attempt.accuracy === 'high' ? AppLocationAccuracy.High : AppLocationAccuracy.Medium;
      const value = await this.bridge.getAppLocation({ accuracy, timeoutMs: attempt.timeout_ms }).catch(() => null);
      if (generation !== this.automaticGeneration) return { ok: false as const, reason: 'cancelled' as const };
      const report = value && locationReport('once', value, requestId, this.timezoneHint());
      if (report && (report.location.accuracy === undefined || report.location.accuracy <= maximumAccuracyM)) {
        this.report(report); return { ok: true as const };
      }
      if (report) lowAccuracy = true;
      if (index < attempts.length - 1) await this.pause(index ? 750 : 250);
    }
    return { ok: false as const, reason: lowAccuracy ? 'low_accuracy' as const : 'unavailable' as const };
  }

  cancelAutomatic(requestId?: string) {
    // getAppLocation has no abort API. Invalidate the generation so a late result
    // is ignored and never sent after the request or conversation was cancelled.
    void requestId; this.automaticGeneration++;
  }

  async start() {
    if (this.active) return true;
    this.lastContinuousReportAt = 0;
    this.unsubscribe = this.bridge.onAppLocationChanged(value => {
      const current = this.now();
      if (current - this.lastContinuousReportAt < 10_000) return;
      const report = locationReport('continuous', value, undefined, this.timezoneHint());
      if (report) { this.lastContinuousReportAt = current; this.report(report); }
    });
    const started = await this.bridge.startAppLocationUpdates({
      accuracy: AppLocationAccuracy.High, timeoutMs: 10_000, intervalMs: 10_000
    }).catch(() => false);
    if (!started) { this.unsubscribe?.(); this.unsubscribe = undefined; return false; }
    this.active = true;
    return true;
  }

  async stop() {
    this.onceGeneration++;
    this.cancelAutomatic();
    if (!this.active && !this.unsubscribe) return true;
    const stopped = await this.bridge.stopAppLocationUpdates().catch(() => false);
    this.unsubscribe?.(); this.unsubscribe = undefined; this.active = false; this.lastContinuousReportAt = 0;
    return stopped;
  }
}
