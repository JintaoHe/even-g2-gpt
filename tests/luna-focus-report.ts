// Read only, synthetic evaluation JSONL -> descriptive statistics. No API calls.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const path = process.argv[2]; assert.ok(path, 'JSONL_PATH_REQUIRED');
const rows = (await readFile(path, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
const cases = rows.filter(r => r.type === 'case' && r.phase.startsWith('focus-'));
const requests = rows.filter(r => r.type === 'request');
const sum = (xs: any[], key: string) => xs.reduce((s,x) => s+(Number.isFinite(x[key]) ? x[key] : 0), 0);
const stats = (values: number[]) => {
  const a = values.filter(Number.isFinite).sort((a,b)=>a-b), n = a.length;
  return n ? { n, median: n%2 ? a[(n-1)/2] : (a[n/2-1]+a[n/2])/2,
    p95: a[Math.ceil(n*.95)-1], min: a[0], max: a[n-1] } : undefined;
};
const grouped = (xs: any[], keys: string[]) => {
  const groups = new Map<string, any[]>();
  for (const x of xs) { const key = keys.map(k=>x[k] ?? '').join('/'); groups.set(key,[...(groups.get(key) ?? []),x]); }
  return [...groups].map(([group,items]) => ({group,items}));
};
const summary = grouped(cases,['phase','scenario','model']).map(({group,items}) => ({group,
  pass:items.filter(x=>x.pass).length, latencyMs:stats(items.map(x=>x.ms)), firstMs:stats(items.map(x=>x.firstMs)),
  chars:stats(items.map(x=>x.chars)), chinese:stats(items.map(x=>x.chinese)) }));
const costs = grouped(requests,['phase','model']).map(({group,items}) => ({group,requests:items.length,
  usageUsd:sum(items,'estimatedUsageUsd'),reservedUsd:sum(items,'reservedUsd'), inputTokens:sum(items,'inputTokens'),
  outputTokens:sum(items,'outputTokens'), cachedTokens:sum(items,'cachedTokens'), reasoningTokens:sum(items,'reasoningTokens'),
  incomplete:items.filter(x=>x.completion!=='completed').length,
  resolvedModels:[...new Set(items.map(x=>x.resolvedModel))] }));
const stages = grouped(requests.filter(x=>x.draftStage),['model','draftStage']).map(({group,items}) => ({group,
  requests:items.length,latencyMs:stats(items.map(x=>x.ms)),usageUsd:sum(items,'estimatedUsageUsd')}));
const paired = grouped(cases,['phase','scenario','repetition']).map(({group,items})=>{
  const a=items.find(x=>x.model==='gpt-5.6-luna'),b=items.find(x=>x.model==='gpt-6-luna');
  return a&&b ? {group,deltaMs6minus56:b.ms-a.ms,ratio:b.ms/a.ms} : undefined;
}).filter(Boolean);
const failures = cases.filter(x=>!x.pass).map(({phase,scenario,model,repetition,failed,error,metaExcerpts,sections,chinese,duplicateHeadings,closedFences,presentation}) =>
  ({phase,scenario,model,repetition,failed,error,metaExcerpts,sections,chinese,duplicateHeadings,closedFences,presentation}));
console.log(JSON.stringify({finished:rows.some(x=>x.type==='final'),summary,costs,stages,paired,failures,
  totalUsageUsd:sum(requests,'estimatedUsageUsd'),final:rows.find(x=>x.type==='final')},null,2));
