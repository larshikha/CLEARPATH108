import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim, isFinished, step } from '../src/sim/engine.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const seeds = Array.from({ length: 50 }, (_, index) => index + 2001);
const config = { density: 'high', roadType: 'multilane', compliance: 0.88 };
const policies = [
  { name: 'Baseline', mode: 'baseline', policy: 'placeholder' },
  { name: 'Placeholder', mode: 'clearpath', policy: 'placeholder' },
  { name: 'Label-rule STOP', mode: 'clearpath', policy: 'label-rule' },
  { name: 'Label-rule cruise-retry', mode: 'clearpath', policy: 'label-rule-retry' },
  { name: 'ML', mode: 'clearpath', policy: 'ml' },
];
const avg = values => values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : null;
const n2 = value => value === null ? 'N/A' : value.toFixed(2);
function run(seed, policy) {
  const sim = createSim({ ...config, ...policy, seed });
  let ticks = 0;
  while (!isFinished(sim) && ticks < 100000) { step(sim); ticks += 1; }
  if (!isFinished(sim)) throw new Error(`${policy.name} seed ${seed} exceeded tick limit`);
  const m = sim.clearanceEpisodes;
  const episodes = m.length ? m.reduce((sum, x) => sum + x, 0) / m.length : 0;
  const stopTotal = sim.stopDurations.reduce((sum, x) => sum + x, 0);
  return {
    seed, policy: policy.name, travelTime: sim.travelTime, clearanceTime: episodes,
    blockedTime: sim.blockedTime, blockedOverHalf: sim.blockedTime / sim.travelTime > 0.5,
    alerts: sim.alertsSent, collisions: sim.collisions,
    stopVehicles: sim.stopVehicleIds.size, stopEpisodes: sim.stopDurations.length,
    stopDurationTotal: stopTotal, meanStopTime: sim.stopDurations.length ? stopTotal / sim.stopDurations.length : null,
    stopLaneVehicles: sim.stopLaneVehicleIds.size, stopLaneVehicleSeconds: sim.stopLaneVehicleSeconds,
    stopLeadBlockers: sim.stopLeadBlockerVehicleIds.size,
    failedLaneChanges: sim.failedLaneChanges,
    alertLeadCount: sim.alertLeadDistances.length,
    alertLeadTotal: sim.alertLeadDistances.reduce((sum, x) => sum + x, 0),
  };
}
const rows = [];
for (const policy of policies) for (const seed of seeds) rows.push(run(seed, policy));
console.log('STOP diagnostic and label-rule retry comparison: high-density multilane, compliance=0.88, seeds 2001-2050');
console.log('Policy | travel | clearance | blocked | >50% blocked | alerts/run | collisions | STOP vehicles | mean STOP duration | mean in-lane STOP time | STOP lead-blockers (share) | failed lane changes | mean alert lead');
for (const policy of policies) {
  const group = rows.filter(row => row.policy === policy.name);
  const stops = group.reduce((sum, row) => sum + row.stopVehicles, 0);
  const laneStopCount = group.reduce((sum, row) => sum + row.stopLaneVehicles, 0);
  const leadCount = group.reduce((sum, row) => sum + row.stopLeadBlockers, 0);
  const stopEpisodes = group.reduce((sum, row) => sum + row.stopEpisodes, 0);
  const leadSamples = group.reduce((sum, row) => sum + row.alertLeadCount, 0);
  const overHalf = group.filter(row => row.blockedOverHalf).length;
  console.log(`${policy.name} | ${n2(avg(group.map(x => x.travelTime)))} | ${n2(avg(group.map(x => x.clearanceTime)))} | ${n2(avg(group.map(x => x.blockedTime)))} | ${overHalf}/50 | ${n2(avg(group.map(x => x.alerts)))} | ${group.reduce((s,x)=>s+x.collisions,0)} | ${stops} | ${n2(stopEpisodes ? group.reduce((s,x)=>s+x.stopDurationTotal,0)/stopEpisodes : null)} | ${n2(laneStopCount ? group.reduce((s,x)=>s+x.stopLaneVehicleSeconds,0)/laneStopCount : null)} | ${leadCount}/${stops} (${stops ? (100*leadCount/stops).toFixed(1) : '0.0'}%) | ${group.reduce((s,x)=>s+x.failedLaneChanges,0)} | ${n2(leadSamples ? group.reduce((s,x)=>s+x.alertLeadTotal,0)/leadSamples : null)}`);
}
const retry = rows.filter(row => row.policy === 'Label-rule cruise-retry');
const stop = rows.filter(row => row.policy === 'Label-rule STOP');
const retryStrict = retry.filter(row => row.travelTime < stop.find(other => other.seed === row.seed).travelTime).length;
console.log(`Label-rule cruise-retry vs STOP: ${retryStrict}/50 strict travel-time wins.`);
const resultsDir = resolve(root, 'web', 'public', 'results');
mkdirSync(resultsDir, { recursive: true });
const columns = Object.keys(rows[0]);
const quote = value => value === null ? '' : /[",\r\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
writeFileSync(resolve(resultsDir, 'phase5-stop-diagnostics-seeds-2001-2050.csv'), [columns.join(','), ...rows.map(row => columns.map(key => quote(row[key])).join(','))].join('\n') + '\n', 'utf8');
