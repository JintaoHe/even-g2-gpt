import type { AirQualityEvidence, PollenEvidence, WeatherEvidence } from './environment.js';

export type PollenKind = 'tree' | 'grass' | 'weed';
export type OutdoorPreferences = { requireAirQuality?: boolean; pollenSensitivity?: PollenKind[];
  temperatureMinC?: number; temperatureMaxC?: number };
export type OutdoorIssue = { code: string; severity: 'block' | 'caution' | 'missing'; value?: number | string };
export type OutdoorDecision = { suitability: 'good' | 'caution' | 'poor' | 'unknown'; confidence: 'high' | 'medium' | 'low';
  issues: OutdoorIssue[]; evidenceUsed: Array<'weather' | 'air_quality' | 'pollen'> };

/**
 * Backend-owned guardrails for an outdoor recommendation. This does not make a
 * medical diagnosis or replace the assistant's contextual tradeoff. It keeps
 * missing evidence from being treated as safe and identifies facts the answer
 * model must explain.
 */
export function assessOutdoor(weather: WeatherEvidence, air: AirQualityEvidence, pollen: PollenEvidence,
  preferences: OutdoorPreferences = {}): OutdoorDecision {
  const issues: OutdoorIssue[] = [], evidenceUsed: OutdoorDecision['evidenceUsed'] = [];
  const minComfort = Number.isFinite(preferences.temperatureMinC) ? Math.max(-20, Math.min(25, preferences.temperatureMinC!)) : 5;
  const maxComfort = Number.isFinite(preferences.temperatureMaxC) ? Math.max(20, Math.min(45, preferences.temperatureMaxC!)) : 32;
  const sensitivities = [...new Set((preferences.pollenSensitivity ?? []).filter(value => ['tree', 'grass', 'weed'].includes(value)))];
  if (!weather.available) issues.push({ code: 'weather_unavailable', severity: 'missing' });
  else {
    evidenceUsed.push('weather');
    const precipitation = weather.precipitationMaxPercent, thunder = weather.thunderstormMaxPercent;
    const feelsMin = weather.feelsLikeMinC, feelsMax = weather.feelsLikeMaxC, wind = weather.windMaxKph, uv = weather.uvMax;
    if (thunder !== undefined && thunder >= 30) issues.push({ code: 'thunderstorm_risk', severity: 'block', value: thunder });
    else if (thunder !== undefined && thunder >= 15) issues.push({ code: 'thunderstorm_possible', severity: 'caution', value: thunder });
    if (precipitation !== undefined && precipitation >= 70) issues.push({ code: 'heavy_precipitation_risk', severity: 'block', value: precipitation });
    else if (precipitation !== undefined && precipitation >= 30) issues.push({ code: 'precipitation_possible', severity: 'caution', value: precipitation });
    if (feelsMin !== undefined && feelsMin < 0) issues.push({ code: 'cold_exposure', severity: 'block', value: feelsMin });
    else if (feelsMin !== undefined && feelsMin < minComfort) issues.push({ code: 'cool_conditions', severity: 'caution', value: feelsMin });
    if (feelsMax !== undefined && feelsMax > 38) issues.push({ code: 'heat_exposure', severity: 'block', value: feelsMax });
    else if (feelsMax !== undefined && feelsMax > maxComfort) issues.push({ code: 'warm_conditions', severity: 'caution', value: feelsMax });
    if (wind !== undefined && wind >= 50) issues.push({ code: 'strong_wind', severity: 'block', value: Math.round(wind) });
    else if (wind !== undefined && wind >= 35) issues.push({ code: 'windy', severity: 'caution', value: Math.round(wind) });
    if (uv !== undefined && uv >= 8) issues.push({ code: 'high_uv', severity: 'caution', value: uv });
  }
  if (!air.available) {
    if (preferences.requireAirQuality !== false) issues.push({ code: 'air_quality_unavailable', severity: 'missing' });
  } else {
    evidenceUsed.push('air_quality');
    if (air.aqiMax !== undefined && air.aqiMax >= 151) issues.push({ code: 'air_quality_unhealthy', severity: 'block', value: air.aqiMax });
    else if (air.aqiMax !== undefined && air.aqiMax >= 101) issues.push({ code: 'air_quality_sensitive_groups', severity: 'caution', value: air.aqiMax });
  }
  if (!pollen.available) {
    if (sensitivities.length) issues.push({ code: 'pollen_unavailable_for_sensitive_user', severity: 'missing' });
  } else {
    evidenceUsed.push('pollen');
    for (const kind of sensitivities) {
      const evidence = pollen[kind];
      if (!evidence.indexAvailable) issues.push({ code: `${kind}_pollen_unknown`, severity: 'missing' });
      else if (evidence.value! >= 4) issues.push({ code: `${kind}_pollen_high_for_sensitive_user`, severity: 'block', value: evidence.value });
      else if (evidence.value! >= 3) issues.push({ code: `${kind}_pollen_moderate_for_sensitive_user`, severity: 'caution', value: evidence.value });
    }
    if (!sensitivities.length && pollen.overallValue !== undefined && pollen.overallValue >= 4)
      issues.push({ code: 'pollen_high', severity: 'caution', value: pollen.overallValue });
  }
  const blocked = issues.some(issue => issue.severity === 'block'), missing = issues.some(issue => issue.severity === 'missing');
  const cautions = issues.some(issue => issue.severity === 'caution');
  return { suitability: !weather.available ? 'unknown' : blocked ? 'poor' : missing || cautions ? 'caution' : 'good',
    confidence: missing ? 'low' : blocked || cautions ? 'medium' : 'high', issues, evidenceUsed };
}
