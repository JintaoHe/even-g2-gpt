import type { DialogueModel, RouteTravelMode } from './conversation.js';
import type { NearbyPreferences } from './nearby-intent.js';
import type { SearchArea } from './search-area.js';
import { prefilterNearby, type PlaceCandidate, type RouteCandidate, type RouteOrigin, type RouteProvider } from './routes.js';
import { freshHours, publicWebsite } from './place-availability.js';

export type AlternativeBranch = { name: string; address: string; sourceUrl: string };
export type ServicePeriod = { day: number; openMinute: number; closeMinute: number };
export type FoodServiceEvidence = {
  kind: 'kitchen' | 'takeout' | 'drive_through'; sourceUrl: string; periods: ServicePeriod[];
};
export const FOOD_ALTERNATIVE_LIMITS = Object.freeze({ rounds: 2, candidates: 2, timeoutMs: 60_000, arrivalMarginMs: 10 * 60_000 });
const clean = (s: unknown, n: number): s is string => typeof s === 'string' && s.trim().length > 0
  && s.length <= n && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(s);
export function parseAlternativeBranches(raw: any, sources: string[]): AlternativeBranch[] {
  if (!Array.isArray(raw?.branches)) return [];
  return raw.branches.slice(0, FOOD_ALTERNATIVE_LIMITS.candidates).flatMap((b: any) => {
    const url = publicWebsite(b?.source_url);
    return clean(b?.name, 160) && clean(b?.address, 240) && url && sources.includes(url)
      ? [{ name: b.name, address: b.address, sourceUrl: url }] : [];
  });
}
export function parseFoodService(raw: any, sources: string[], website: string): FoodServiceEvidence | undefined {
  const url = publicWebsite(raw?.source_url), official = publicWebsite(website);
  if (raw?.branch_matches !== true || raw?.exceptions_conflict !== false || !url || !official
    || new URL(url).hostname !== new URL(official).hostname || !sources.includes(url)
    || !['kitchen', 'takeout', 'drive_through'].includes(raw?.kind)
    || !Array.isArray(raw?.periods) || !raw.periods.length || raw.periods.length > 21) return;
  if (!raw.periods.every((p: any) => Number.isInteger(p?.day) && p.day >= 0 && p.day <= 6
    && Number.isInteger(p.open_minute) && p.open_minute >= 0 && p.open_minute < 1440
    && Number.isInteger(p.close_minute) && p.close_minute > p.open_minute
    && p.close_minute <= p.open_minute + 1440)) return;
  return { kind: raw.kind, sourceUrl: url, periods: raw.periods.map((p: any) => ({
    day: p.day, openMinute: p.open_minute, closeMinute: p.close_minute })) };
}

/** Evaluate the START weekday, including yesterday's overnight period. No model-produced dates. */
export function serviceCovers(periods: ServicePeriod[], timezone: string, from: number, through: number): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(through) || through < from || through - from > 2 * 3600_000) return false;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const local = (at: number) => {
      const p = Object.fromEntries(fmt.formatToParts(at).map(x => [x.type, x.value]));
      return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday) * 1440 + Number(p.hour) * 60 + Number(p.minute);
    };
    const start = local(from), end = local(through), span = (end - start + 10080) % 10080;
    // Refuse DST jumps rather than silently making a fixed-offset arrival assertion.
    if (Math.abs(span - (through - from) / 60_000) > 1) return false;
    return periods.some(p => [-10080, 0, 10080].some(shift => {
      const a = p.day * 1440 + p.openMinute + shift, b = p.day * 1440 + p.closeMinute + shift;
      return a <= start && b > start + span;
    }));
  } catch { return false; }
}

// Deliberately conservative: a chain name alone is not a branch identity. No fuzzy LLM match.
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\b(street|road|avenue|drive|parkway)\b/g,
  v => ({street:'st',road:'rd',avenue:'ave',drive:'dr',parkway:'pkwy'})[v]!).replace(/[^\p{L}\p{N}]/gu, '');
export function sameBranch(a: AlternativeBranch, b: PlaceCandidate) {
  const x = a.address.split(','), y = b.address?.split(',') ?? [];
  const nameParts = a.name.split(/\s+[—–]\s+/);
  const sameName = norm(a.name) === norm(b.name) || (nameParts.length === 2 && norm(nameParts[0]) === norm(b.name)
    && norm(nameParts[1]) === norm(x[0]));
  return sameName && x.length >= 3 && y.length >= 3
    && x.slice(0, 2).every((s, i) => norm(s) === norm(y[i]))
    && norm(x[2]).replace(/\d/g, '') === norm(y[2]).replace(/\d/g, '');
}
export type VerifiedFoodOption = { place: RouteCandidate; service: FoodServiceEvidence; checkedAt: number };
export async function verifiedFoodAlternatives(query: string, area: SearchArea, origin: RouteOrigin,
  mode: RouteTravelMode, prefs: NearbyPreferences, model: DialogueModel, routes: RouteProvider,
  signal: AbortSignal, now = Date.now): Promise<VerifiedFoodOption[]> {
  if (!model.findFoodAlternatives || !model.verifyFoodService || !routes.discover || !routes.verifyPlace) return [];
  // These requirements need evidence beyond hours; never silently relax them.
  if (prefs.unhandledExclusions || (prefs.vibe && prefs.vibe !== 'any')) return [];
  const local = new AbortController(), timer = setTimeout(() => local.abort(new Error('ALTERNATIVE_TIMEOUT')), FOOD_ALTERNATIVE_LIMITS.timeoutMs);
  const combined = AbortSignal.any([signal, local.signal]);
  const run = async () => {
    const options: VerifiedFoodOption[] = [], seen = new Set<string>(), attempted: AlternativeBranch[] = [];
    for (let round = 0; round < FOOD_ALTERNATIVE_LIMITS.rounds && !options.length; round++) {
      const found = await model.findFoodAlternatives!(query, area, prefs, now(), combined, attempted);
      combined.throwIfAborted();
      for (const branch of found.slice(0, FOOD_ALTERNATIVE_LIMITS.candidates)) {
        if (attempted.some(b => norm(b.name) === norm(branch.name) && norm(b.address) === norm(branch.address))) continue;
        attempted.push(branch);
        try {
          combined.throwIfAborted();
          const request = { origin, mode, kind: 'nearby' as const, nearbyPreferences: prefs, destination: `${branch.name}, ${branch.address}` };
          const discovery = await routes.discover!(request, combined); combined.throwIfAborted();
          const matches = discovery.candidates.filter(c => sameBranch(branch, c));
          if (matches.length !== 1 || seen.has(matches[0].placeId)) continue;
          seen.add(matches[0].placeId);
          const detail = await routes.verifyPlace!(matches[0], combined); combined.throwIfAborted();
          if (detail.placeId !== matches[0].placeId || !sameBranch(branch, detail) || !detail.website || !detail.timeZone
            || !freshHours(detail.hours, now()) || detail.hours?.source !== 'google' || detail.hours.openNow !== true
            || !Number.isFinite(detail.hours.closesAt) || (detail.businessStatus && detail.businessStatus !== 'OPERATIONAL')) continue;
          if (!prefilterNearby([detail], prefs).candidates.length || (prefs.priceCeiling && !detail.priceLevel)) continue;
          const route = await routes.route({ ...request, candidates: [detail] }, combined); combined.throwIfAborted();
          const routed = route.candidates.find(c => c.placeId === detail.placeId);
          if (!routed || !Number.isFinite(routed.durationSeconds) || routed.durationSeconds < 0 || routed.durationSeconds > 6600) continue;
          const service = await model.verifyFoodService!(detail, now(), combined); combined.throwIfAborted();
          if (!service || (service.kind === 'drive_through' && mode !== 'drive')) continue;
          const checkedAt = now(), through = checkedAt + routed.durationSeconds * 1000 + FOOD_ALTERNATIVE_LIMITS.arrivalMarginMs;
          if (!freshHours(detail.hours, checkedAt) || detail.hours.closesAt! <= through
            || detail.hours.foodOpenNow === false || (detail.hours.foodClosesAt !== undefined && detail.hours.foodClosesAt <= through)
            || !serviceCovers(service.periods, detail.timeZone, checkedAt, through)) continue;
          options.push({ place: { ...routed, ...detail }, service, checkedAt });
        } catch { combined.throwIfAborted(); /* Unknown evidence excludes only this branch. */ }
      }
    }
    return options.filter(o => {
      const at = now(), through = at + o.place.durationSeconds * 1000 + FOOD_ALTERNATIVE_LIMITS.arrivalMarginMs;
      return freshHours(o.place.hours, at) && o.place.hours!.closesAt! > through
        && serviceCovers(o.service.periods, o.place.timeZone!, at, through);
    });
  };
  let abort!: () => void;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      abort = () => reject(combined.reason); combined.addEventListener('abort', abort, {once:true});
      if (combined.aborted) abort();
    })]);
  } catch { signal.throwIfAborted(); return []; }
  finally { clearTimeout(timer); combined.removeEventListener('abort', abort); }
}

export function foodAlternativeText(options: VerifiedFoodOption[], area: SearchArea, mode: RouteTravelMode) {
  if (!options.length) return `目前还没拿到${area.labels[0]}同时满足“现在供餐”和“到达后仍来得及”的完整证据，所以没有把未核实的店当作可去推荐。可以继续讨论扩大范围，或改查稍晚有明确供餐时段的选择。`;
  const travel = {drive:'驾车',walk:'步行',bicycle:'骑行'}[mode];
  return `我另外核对了具体分店，以下选择有营业与供餐依据：\n` + options.map((o, i) =>
    `${i + 1}. ${o.place.name}（${o.place.address}）：${travel}约${Math.ceil(o.place.durationSeconds / 60)}分钟；Google 当前营业状态与官网${{kitchen:'厨房',takeout:'取餐',drive_through:'得来速'}[o.service.kind]}时段相符，预计到达后至少留有10分钟。`)
    .join('\n') + '\n这是刚查到的状态，不保证临时停餐或售罄。你可以选一家，也可以继续讨论。';
}
