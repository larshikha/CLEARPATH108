import { createSim, step, isFinished, getState, DT } from '../src/sim/engine.js';

function run(mode, seed = 108) {
  const sim = createSim({ seed, density: 'high', roadType: 'multilane', mode });
  let steps = 0;
  while (!isFinished(sim) && steps < 100000) {
    step(sim);
    steps += 1;
  }
  if (!isFinished(sim)) throw new Error(`${mode} did not finish within ${steps} steps`);
  return getState(sim);
}

function sameLayout(a, b) {
  return JSON.stringify(a.vehicles.filter(v => v.id.startsWith('v')).map(({ id, x, lane, speed }) => ({ id, x, lane, speed }))) ===
    JSON.stringify(b.vehicles.filter(v => v.id.startsWith('v')).map(({ id, x, lane, speed }) => ({ id, x, lane, speed })));
}

const baseline = run('baseline');
const clearpath = run('clearpath');
if (!sameLayout(createSim({ seed: 108, density: 'high', mode: 'baseline' }), createSim({ seed: 108, density: 'high', mode: 'clearpath' }))) {
  throw new Error('Seeded traffic differs between modes');
}
if (baseline.metrics.collisions !== 0 || clearpath.metrics.collisions !== 0) throw new Error('Collision check failed');

console.log(`CLEARPATH Phase 1 seeded comparison (seed 108, high density, multilane; dt=${DT}s)`);
console.log('Metric                 Baseline       CLEARPATH');
console.log(`Travel time (s)        ${baseline.metrics.travelTime.toFixed(1).padStart(8)}       ${clearpath.metrics.travelTime.toFixed(1).padStart(8)}`);
console.log(`Clearance time (s)     ${baseline.metrics.clearanceTime.toFixed(1).padStart(8)}       ${clearpath.metrics.clearanceTime.toFixed(1).padStart(8)}`);
console.log(`Blocked time (s)       ${baseline.metrics.blockedTime.toFixed(1).padStart(8)}       ${clearpath.metrics.blockedTime.toFixed(1).padStart(8)}`);
console.log(`Alerts sent            ${String(baseline.metrics.alertsSent).padStart(8)}       ${String(clearpath.metrics.alertsSent).padStart(8)}`);
console.log(`Collisions             ${String(baseline.metrics.collisions).padStart(8)}       ${String(clearpath.metrics.collisions).padStart(8)}`);
const travelImprovement = baseline.metrics.travelTime ? (baseline.metrics.travelTime - clearpath.metrics.travelTime) / baseline.metrics.travelTime * 100 : 0;
const clearanceImprovement = baseline.metrics.clearanceTime ? (baseline.metrics.clearanceTime - clearpath.metrics.clearanceTime) / baseline.metrics.clearanceTime * 100 : 0;
console.log(`Improvement (%)        ${''.padStart(8)}       ${travelImprovement.toFixed(1)} travel / ${clearanceImprovement.toFixed(1)} clearance`);
