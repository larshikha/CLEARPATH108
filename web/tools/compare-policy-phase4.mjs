import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim, isFinished, step } from '../src/sim/engine.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const seeds = Array.from({ length: 50 }, (_, index) => index + 2001);
const config = { density: 'high', roadType: 'multilane', compliance: 0.88 };
const policies = [
  { name: 'baseline', mode: 'baseline', policy: 'placeholder' },
  { name: 'placeholder', mode: 'clearpath', policy: 'placeholder' },
  { name: 'training-label rule', mode: 'clearpath', policy: 'label-rule' },
  { name: 'ML move + placeholder corridor', mode: 'clearpath', policy: 'placeholder', movePolicy: 'ml', corridorPolicy: 'placeholder' },
  { name: 'placeholder move + ML corridor', mode: 'clearpath', policy: 'placeholder', movePolicy: 'placeholder', corridorPolicy: 'ml' },
  { name: 'ML', mode: 'clearpath', policy: 'ml' },
];

function run(seed, policy) {
  const sim = createSim({ ...config, ...policy, seed });
  let ticks = 0;
  while (!isFinished(sim) && ticks < 100000) {
    step(sim);
    ticks += 1;
  }
  if (!isFinished(sim)) throw new Error(`${policy.name} run for seed ${seed} exceeded tick limit`);
  const episodes = sim.clearanceEpisodes;
  const clearanceTime = episodes.length ? episodes.reduce((sum, value) => sum + value, 0) / episodes.length : 0;
  const stopDurationTotal = sim.stopDurations.reduce((sum, value) => sum + value, 0);
  const meanStopTime = sim.stopDurations.length ? stopDurationTotal / sim.stopDurations.length : null;
  const alertLeadTotal = sim.alertLeadDistances.reduce((sum, value) => sum + value, 0);
  const meanAlertLeadDistance = sim.alertLeadDistances.length ? alertLeadTotal / sim.alertLeadDistances.length : null;
  return {
    seed, policy: policy.name, travelTime: sim.travelTime, clearanceTime, blockedTime: sim.blockedTime,
    blockedShare: sim.blockedTime / sim.travelTime, blockedOverHalf: sim.blockedTime / sim.travelTime > 0.5,
    alerts: sim.alertsSent, collisions: sim.collisions,
    stopVehicles: sim.stopVehicleIds.size, stopEpisodes: sim.stopDurations.length, stopDurationTotal, meanStopTime,
    failedLaneChanges: sim.failedLaneChanges, alertLeadCount: sim.alertLeadDistances.length, alertLeadTotal, meanAlertLeadDistance,
  };
}

const rows = [];
for (const policy of policies) {
  for (const seed of seeds) rows.push(run(seed, policy));
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const n2 = value => value === null ? 'N/A' : value.toFixed(2);
console.log('Phase 4 policy comparison: high-density multilane, compliance=0.88, seeds 2001-2050');
console.log('Policy | travel s | clearance s | blocked s | runs blocked >50% | STOP vehicles total (avg/run) | STOP mean s | failed lane changes | mean alert lead m | alerts/run | collisions');
for (const policy of policies) {
  const group = rows.filter(row => row.policy === policy.name);
  const totalStopEpisodes = group.reduce((sum, row) => sum + row.stopEpisodes, 0);
  const meanStopTime = totalStopEpisodes ? group.reduce((sum, row) => sum + row.stopDurationTotal, 0) / totalStopEpisodes : null;
  const alertCount = group.reduce((sum, row) => sum + row.alertLeadCount, 0);
  const meanAlertLead = alertCount ? group.reduce((sum, row) => sum + row.alertLeadTotal, 0) / alertCount : null;
  const overHalf = group.filter(row => row.blockedOverHalf).length;
  const stops = group.reduce((sum, row) => sum + row.stopVehicles, 0);
  console.log(`${policy.name} | ${n2(mean(group.map(row => row.travelTime)))} | ${n2(mean(group.map(row => row.clearanceTime)))} | ${n2(mean(group.map(row => row.blockedTime)))} | ${overHalf}/50 (${(100 * overHalf / 50).toFixed(1)}%) | ${stops} (${n2(stops / 50)}) | ${n2(meanStopTime)} | ${group.reduce((sum, row) => sum + row.failedLaneChanges, 0)} | ${n2(meanAlertLead)} | ${n2(mean(group.map(row => row.alerts)))} | ${group.reduce((sum, row) => sum + row.collisions, 0)}`);
}

const mlRows = rows.filter(row => row.policy === 'ML');
const placeholderRows = rows.filter(row => row.policy === 'placeholder');
const strictWins = mlRows.filter(row => row.travelTime < placeholderRows.find(other => other.seed === row.seed).travelTime).length;
const noWorse = mlRows.filter(row => row.travelTime <= placeholderRows.find(other => other.seed === row.seed).travelTime).length;
console.log(`ML vs placeholder travel-time wins: ${strictWins}/50 strict; ${noWorse}/50 no-worse.`);

const csvColumns = Object.keys(rows[0]);
const quote = value => value === null ? '' : /[",\r\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
const resultsDir = resolve(root, 'web', 'public', 'results');
mkdirSync(resultsDir, { recursive: true });
writeFileSync(resolve(resultsDir, 'phase4-policy-comparison-seeds-2001-2050.csv'),
  [csvColumns.join(','), ...rows.map(row => csvColumns.map(key => quote(row[key])).join(','))].join('\n') + '\n', 'utf8');
console.log(`Per-seed rows: ${resolve(resultsDir, 'phase4-policy-comparison-seeds-2001-2050.csv')}`);
