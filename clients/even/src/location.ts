import { AppLocationAccuracy, type AppLocation, type AppLocationOptions } from '@evenrealities/even_hub_sdk';

export type LocationMode = 'once' | 'continuous';
export type LocationReport = {
  type: 'location.report';
  mode: LocationMode;
  location: { latitude: number; longitude: number; accuracy?: number; timestamp?: number };
};

type LocationBridge = {
  getAppLocation(options?: AppLocationOptions): Promise<AppLocation | null>;
  startAppLocationUpdates(options?: AppLocationOptions): Promise<boolean>;
  stopAppLocationUpdates(): Promise<boolean>;
  onAppLocationChanged(callback: (location: AppLocation) => void): () => void;
};

export function locationReport(mode: LocationMode, value: AppLocation): LocationReport | undefined {
  if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90
    || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) return undefined;
  const accuracy = value.accuracy;
  const timestamp = value.timestamp;
  if (accuracy !== undefined && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10_000)) return undefined;
  if (timestamp !== undefined && (!Number.isFinite(timestamp) || timestamp <= 0)) return undefined;
  return { type: 'location.report', mode, location: {
    latitude: value.latitude, longitude: value.longitude,
    ...(accuracy === undefined ? {} : { accuracy }), ...(timestamp === undefined ? {} : { timestamp })
  } };
}

export class LocationController {
  private unsubscribe?: () => void;
  private active = false;
  private bridge: LocationBridge;
  private report: (value: LocationReport) => void;
  constructor(bridge: LocationBridge, report: (value: LocationReport) => void) {
    this.bridge = bridge;
    this.report = report;
  }

  async once() {
    const value = await this.bridge.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: 10_000 });
    const report = value && locationReport('once', value);
    if (report) this.report(report);
    return !!report;
  }

  async start() {
    if (this.active) return true;
    this.unsubscribe = this.bridge.onAppLocationChanged(value => {
      const report = locationReport('continuous', value);
      if (report) this.report(report);
    });
    const started = await this.bridge.startAppLocationUpdates({
      accuracy: AppLocationAccuracy.High, timeoutMs: 10_000, distanceFilter: 25, intervalMs: 15_000
    }).catch(() => false);
    if (!started) { this.unsubscribe?.(); this.unsubscribe = undefined; return false; }
    this.active = true;
    return true;
  }

  async stop() {
    if (!this.active && !this.unsubscribe) return true;
    const stopped = await this.bridge.stopAppLocationUpdates().catch(() => false);
    this.unsubscribe?.(); this.unsubscribe = undefined; this.active = false;
    return stopped;
  }
}
