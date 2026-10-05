import { createSim, step, isFinished, getState } from '../src/sim/engine.js';

const densities = ['low', 'med', 'high'];
const rows = [];
const run = (seed, density, mode) => {
  const sim = createSim({ seed, density, mode, roadType: 'multilane' });
  let ticks = 0;
  while (!isFinished(sim) && ticks < 100000) {
    step(sim);
    ticks += 1;
  }
  if (!isFinished(sim)) throw new Error(`${mode}/${density}/${seed} exceeded the tick limit`);
  return getState(sim).metrics;
};
const fmt = value => value.toFixed(1);
const episodes = metrics => `${metrics.clearanceEpisodeCount}:[${metrics.clearanceEpisodes.map(fmt).join(',')}]`;

console.log('CLEARPATH Phase 1 review: multilane, dt=0.1 s, seeds 1-20');
console.log('Density | Seed | Base travel / clear / blocked / alerts / collisions | Base episodes n:[durations] | CLEARPATH travel / clear / blocked / alerts / collisions | CLEARPATH episodes n:[durations]');
for (const density of densities) {
  for (let seed = 1; seed <= 20; seed += 1) {
    const baseline = run(seed, density, 'baseline');
    const clearpath = run(seed, density, 'clearpath');
    if (baseline.alertsSent !== 0) throw new Error(`Baseline counted alerts for ${density}/${seed}`);
    rows.push({ density, seed, baseline, clearpath });
    console.log(`${density} | ${String(seed).padStart(2, '0')} | ${fmt(baseline.travelTime)} / ${fmt(baseline.clearanceTime)} / ${fmt(baseline.blockedTime)} / ${baseline.alertsSent} / ${baseline.collisions} | ${episodes(baseline)} | ${fmt(clearpath.travelTime)} / ${fmt(clearpath.clearanceTime)} / ${fmt(clearpath.blockedTime)} / ${clearpath.alertsSent} / ${clearpath.collisions} | ${episodes(clearpath)}`);
  }
}
console.log('\n20-seed means and CLEARPATH travel-time share');
console.log('Density | Baseline travel / clearance / blocked / alerts / collisions | CLEARPATH travel / clearance / blocked / alerts / collisions | CLEARPATH <= baseline');
for (const density of densities) {
  const subset = rows.filter(row => row.density === density);
  const mean = (mode, key) => subset.reduce((sum, row) => sum + row[mode][key], 0) / subset.length;
  const wins = subset.filter(row => row.clearpath.travelTime <= row.baseline.travelTime + 1e-9).length;
  console.log(`${density} | ${fmt(mean('baseline', 'travelTime'))} / ${fmt(mean('baseline', 'clearanceTime'))} / ${fmt(mean('baseline', 'blockedTime'))} / ${fmt(mean('baseline', 'alertsSent'))} / ${fmt(mean('baseline', 'collisions'))} | ${fmt(mean('clearpath', 'travelTime'))} / ${fmt(mean('clearpath', 'clearanceTime'))} / ${fmt(mean('clearpath', 'blockedTime'))} / ${fmt(mean('clearpath', 'alertsSent'))} / ${fmt(mean('clearpath', 'collisions'))} | ${wins}/20 (${fmt(wins / 20 * 100)}%)`);
}
const baselineCollisions = rows.reduce((sum, row) => sum + row.baseline.collisions, 0);
const clearpathCollisions = rows.reduce((sum, row) => sum + row.clearpath.collisions, 0);
console.log(`Sanity: baseline alerts=0; collisions baseline=${baselineCollisions}, CLEARPATH=${clearpathCollisions}.`);
