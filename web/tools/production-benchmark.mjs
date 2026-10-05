import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim, isFinished, step } from '../src/sim/engine.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const resultsDir = resolve(root, 'web/public/results');
const freeze = JSON.parse(readFileSync(resolve(resultsDir, 'production-policy-freeze.json'), 'utf8'));
const config = JSON.parse(readFileSync(resolve(root, freeze.configFile), 'utf8'));
const hashedInputs = [
  'web/src/sim/engine.js', 'web/src/sim/roads.js', 'web/src/sim/features.js',
  'web/public/models/corridor.json', 'web/public/models/eta.json',
  'web/public/models/move_side.json', freeze.configFile,
];
for (const path of hashedInputs) {
  const expected = freeze.hashes[path];
  const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  if (!expected || actual !== expected) throw new Error(`Frozen simulation input changed before benchmark: ${path}`);
}

const seeds = Array.from({ length: config.seedEnd - config.seedStart + 1 }, (_, i) => config.seedStart + i);
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const lower = Math.floor(at), upper = Math.ceil(at);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (at - lower);
};
function stats(values) {
  if (values.length === 0) return { mean: null, stdDev: null, median: null, p10: null, p90: null, worst: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const stdDev = Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
  return { mean, stdDev, median: quantile(values, 0.5), p10: quantile(values, 0.1), p90: quantile(values, 0.9), worst: Math.max(...values) };
}
function simulate(seed, roadType, density, mode) {
  const sim = createSim({ ...config.policies[mode], seed, density, roadType, compliance: config.compliance });
  let ticks = 0;
  while (!isFinished(sim) && ticks < 100000) { step(sim); ticks += 1; }
  if (!isFinished(sim)) throw new Error(`${roadType}/${density}/${mode} seed ${seed} exceeded tick limit`);
  const clearanceTime = sim.clearanceEpisodes.length
    ? sim.clearanceEpisodes.reduce((sum, duration) => sum + duration, 0) / sim.clearanceEpisodes.length : 0;
  return { travelTime: sim.travelTime, clearanceTime, blockedTime: sim.blockedTime, alerts: sim.alertsSent, collisions: sim.collisions };
}
function summarize(rows, mode) {
  const values = metric => rows.map(row => row[mode][metric]);
  return Object.fromEntries(['travelTime', 'clearanceTime', 'blockedTime', 'alerts', 'collisions']
    .map(metric => [metric, stats(values(metric))]));
}

const scenarios = [];
const fmt = value => value.toFixed(2);
console.log(`Production benchmark: seeds ${config.seedStart}-${config.seedEnd}; compliance=${config.compliance}; paired baseline/CLEARPATH`);
console.log(`Freeze verified for ${hashedInputs.length} simulator, road, feature, model JSON and config inputs.`);
console.log('Road | Density | Baseline travel mean±SD | CLEARPATH travel mean±SD | Travel improvement | Baseline clearance mean±SD | CLEARPATH clearance mean±SD | Clearance improvement | Baseline blocked mean±SD | CLEARPATH blocked mean±SD | Strict wins | Collisions baseline/CLEARPATH');
for (const roadType of config.roadTypes) {
  for (const density of config.densityByRoad[roadType]) {
    const rows = [];
    for (const seed of seeds) {
      const baseline = simulate(seed, roadType, density, 'baseline');
      const clearpath = simulate(seed, roadType, density, 'clearpath');
      rows.push({ seed, baseline, clearpath,
        travelImprovementPct: 100 * (baseline.travelTime - clearpath.travelTime) / baseline.travelTime,
        clearanceImprovementPct: baseline.clearanceTime > 0
          ? 100 * (baseline.clearanceTime - clearpath.clearanceTime) / baseline.clearanceTime : null,
      });
    }
    const baseline = summarize(rows, 'baseline');
    const clearpath = summarize(rows, 'clearpath');
    const travelImprovements = rows.map(row => row.travelImprovementPct);
    const clearanceImprovements = rows.map(row => row.clearanceImprovementPct).filter(Number.isFinite);
    const comparison = {
      travelImprovementPct: stats(travelImprovements),
      clearanceImprovementPct: stats(clearanceImprovements),
      clearanceImprovementSampleCount: clearanceImprovements.length,
      strictWins: rows.filter(row => row.clearpath.travelTime < row.baseline.travelTime).length,
      noWorseRuns: rows.filter(row => row.clearpath.travelTime <= row.baseline.travelTime).length,
      strictLosses: rows.filter(row => row.clearpath.travelTime > row.baseline.travelTime).length,
      totalCollisions: {
        baseline: rows.reduce((sum, row) => sum + row.baseline.collisions, 0),
        clearpath: rows.reduce((sum, row) => sum + row.clearpath.collisions, 0),
      },
    };
    const scenario = {
      roadType, density, polished: !config.unpolishedRoadTypes.includes(roadType),
      seedCount: rows.length,
      policyNames: config.policyNames,
      baseline: { policyName: config.policyNames.baseline, metrics: baseline },
      clearpath: { policyName: config.policyNames.clearpath, metrics: clearpath },
      comparison,
      perSeed: rows,
    };
    scenarios.push(scenario);
    console.log(`${roadType} | ${density} | ${fmt(baseline.travelTime.mean)}±${fmt(baseline.travelTime.stdDev)} | ${fmt(clearpath.travelTime.mean)}±${fmt(clearpath.travelTime.stdDev)} | ${fmt(comparison.travelImprovementPct.mean)}% | ${fmt(baseline.clearanceTime.mean)}±${fmt(baseline.clearanceTime.stdDev)} | ${fmt(clearpath.clearanceTime.mean)}±${fmt(clearpath.clearanceTime.stdDev)} | ${fmt(comparison.clearanceImprovementPct.mean)}% | ${fmt(baseline.blockedTime.mean)}±${fmt(baseline.blockedTime.stdDev)} | ${fmt(clearpath.blockedTime.mean)}±${fmt(clearpath.blockedTime.stdDev)} | ${comparison.strictWins}/${rows.length} | ${comparison.totalCollisions.baseline}/${comparison.totalCollisions.clearpath}`);
  }
}

const result = {
  schemaVersion: 2,
  generatedDate: new Date().toISOString(),
  seedStart: config.seedStart,
  seedEnd: config.seedEnd,
  seedCount: seeds.length,
  compliance: config.compliance,
  policies: config.policyNames,
  configFile: freeze.configFile,
    seedCountPerScenario: seeds.length,
    compliance: config.compliance,
    statistics: {
    standardDeviation: 'Population standard deviation across seeds (divide by N).',
    quantiles: 'Linear interpolation between adjacent sorted observations.',
    worstCase: 'Maximum observed value in the seed group.',
    clearanceTime: 'Per-run mean duration across that run’s blocking episodes; baseline window is 420 m and CLEARPATH window is the predicted corridor length.',
    improvement: 'Per-seed paired percentage: 100 * (baseline - CLEARPATH) / baseline; aggregate values summarize those paired percentages.',
  },
    scenarios,
  freeze: { manifest: '/results/production-policy-freeze.json', hashes: freeze.hashes },
};
mkdirSync(resultsDir, { recursive: true });
writeFileSync(resolve(resultsDir, 'benchmark.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(`Results JSON: ${resolve(resultsDir, 'benchmark.json')}`);
