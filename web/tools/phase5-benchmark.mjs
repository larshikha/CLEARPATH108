import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim, isFinished, step } from '../src/sim/engine.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const freezePath = resolve(root, 'web/public/results/phase5-policy-freeze.json');
const freeze = JSON.parse(readFileSync(freezePath, 'utf8'));
for (const [path, expected] of Object.entries(freeze.hashes)) {
  const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  if (actual !== expected) throw new Error(`Frozen file changed before benchmark: ${path}`);
}
const seeds = Array.from({ length: 100 }, (_, index) => index + 4001);
const config = { density: freeze.density, roadType: freeze.roadType, compliance: freeze.compliance };
const policies = [
  { name: 'Baseline', mode: 'baseline', policy: 'placeholder' },
  { name: 'Placeholder', mode: 'clearpath', policy: 'placeholder' },
  { name: 'ML', mode: 'clearpath', policy: 'ml' },
  { name: 'Placeholder move + ML corridor', mode: 'clearpath', policy: 'placeholder', movePolicy: 'placeholder', corridorPolicy: 'ml', etaPolicy: 'placeholder' },
];
const blockedRows = [];
function run(seed, policy) {
  const sim = createSim({ ...config, ...policy, seed, captureBlockedTicks: true, capturePolicyName: policy.name });
  let ticks = 0;
  while (!isFinished(sim) && ticks < 100000) { step(sim); ticks += 1; }
  if (!isFinished(sim)) throw new Error(`${policy.name} seed ${seed} exceeded tick limit`);
  blockedRows.push(...sim.blockedTickLog.map(log => ({ ...log, policy: policy.name })));
  const clearance = sim.clearanceEpisodes.length ? sim.clearanceEpisodes.reduce((sum, value) => sum + value, 0) / sim.clearanceEpisodes.length : 0;
  return { seed, policy: policy.name, travelTime: sim.travelTime, clearanceTime: clearance, blockedTime: sim.blockedTime, alerts: sim.alertsSent, collisions: sim.collisions };
}
const rows = [];
for (const policy of policies) for (const seed of seeds) rows.push(run(seed, policy));
const mean = xs => xs.reduce((sum, value) => sum + value, 0) / xs.length;
const fmt = value => value.toFixed(2);
console.log('Move-side ML diagnosis: high-density multilane, compliance=0.88, seeds 4001-4100 (frozen policies)');
console.log('Policy | mean travel s | mean clearance s | mean blocked s | mean alerts/run | collisions | strict travel wins vs baseline');
for (const policy of policies) {
  const group = rows.filter(row => row.policy === policy.name);
  const baseline = rows.filter(row => row.policy === 'Baseline');
  const strictWins = policy.name === 'Baseline' ? '—' : `${group.filter(row => row.travelTime < baseline.find(other => other.seed === row.seed).travelTime).length}/100`;
  console.log(`${policy.name} | ${fmt(mean(group.map(x=>x.travelTime)))} | ${fmt(mean(group.map(x=>x.clearanceTime)))} | ${fmt(mean(group.map(x=>x.blockedTime)))} | ${fmt(mean(group.map(x=>x.alerts)))} | ${group.reduce((sum,x)=>sum+x.collisions,0)} | ${strictWins}`);
}
for (const name of ['Placeholder', 'ML']) {
  const group = rows.filter(row => row.policy === name);
  const base = rows.filter(row => row.policy === 'Baseline');
  const strict = group.filter(row => row.travelTime < base.find(other=>other.seed===row.seed).travelTime).length;
  const noWorse = group.filter(row => row.travelTime <= base.find(other=>other.seed===row.seed).travelTime).length;
  console.log(`${name} vs Baseline: ${strict}/100 strict wins; ${noWorse}/100 no-worse runs.`);
}
const ml = rows.filter(row => row.policy === 'ML');
const placeholder = rows.filter(row => row.policy === 'Placeholder');
console.log(`ML vs Placeholder: ${ml.filter(row=>row.travelTime < placeholder.find(other=>other.seed===row.seed).travelTime).length}/100 strict wins; ${ml.filter(row=>row.travelTime <= placeholder.find(other=>other.seed===row.seed).travelTime).length}/100 no-worse runs.`);
const resultPath = resolve(root, 'web/public/results/phase5-benchmark-seeds-4001-4100.csv');
mkdirSync(resolve(root, 'web/public/results'), { recursive: true });
const columns = Object.keys(rows[0]);
const quote = value => /[",\r\n]/.test(String(value)) ? `"${String(value).replaceAll('"','""')}"` : String(value);
writeFileSync(resultPath, [columns.join(','), ...rows.map(row => columns.map(key => quote(row[key])).join(','))].join('\n') + '\n', 'utf8');
console.log(`Per-seed results: ${resultPath}`);

const traceColumns = Object.keys(blockedRows[0] ?? { seed: '', policy: '', time: '', leadBlockerId: '', leadAction: '', lastReevaluationTime: '', waitingForGap: '', retryReason: '' });
const tracePath = resolve(root, 'web/public/results/phase5-blocked-ticks-seeds-4001-4100.csv');
writeFileSync(tracePath, [traceColumns.join(','), ...blockedRows.map(row => traceColumns.map(key => quote(row[key] ?? '')).join(','))].join('\n') + '\n', 'utf8');
console.log(`Per-blocked-tick lead trace: ${tracePath} (${blockedRows.length} rows)`);

for (const name of ['Placeholder', 'ML', 'Placeholder move + ML corridor']) {
  const group = blockedRows.filter(row => row.policy === name);
  const retryRows = group.filter(row => row.retryReason === 'NONE' || row.retryReason === 'NO_GAP');
  const byRunLead = new Map();
  for (const row of group) {
    if (!row.leadBlockerId) continue;
    const key = `${row.seed}/${row.leadBlockerId}`;
    if (!byRunLead.has(key)) byRunLead.set(key, []);
    byRunLead.get(key).push(row);
  }
  let checked = 0, onTick = 0;
  for (const series of byRunLead.values()) {
    series.sort((a,b) => a.time - b.time);
    for (let i=1;i<series.length;i+=1) {
      const previous=series[i-1], current=series[i];
      if ((previous.retryReason==='NONE'||previous.retryReason==='NO_GAP') && Math.abs((current.time-previous.time)-0.1)<1e-7) {
        checked += 1;
        if (Math.abs((Number(current.lastReevaluationTime)-Number(previous.lastReevaluationTime))-0.1)<1e-7) onTick += 1;
      }
    }
  }
  console.log(`${name} retry audit: ${retryRows.length} blocked ticks with NONE/no-gap lead action; ${onTick}/${checked} consecutive lead-blocker ticks re-evaluated at the 0.1 s fixed-dt cadence.`);
}
