import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadForest } from '../src/sim/forest.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const model = JSON.parse(readFileSync(resolve(root, 'web/public/models/move_side.json'), 'utf8'));
const samples = JSON.parse(readFileSync(resolve(root, 'web/public/models/forest_match_samples.json'), 'utf8'));
const forest = loadForest(model);
let maxProbabilityDifference = 0;
const coverage = new Map();
for (const [index, sample] of samples.entries()) {
  const group = `${sample.road_type}/${sample.action}`;
  coverage.set(group, (coverage.get(group) ?? 0) + 1);
  const actual = forest.predict(sample.features);
  if (actual !== sample.expected) throw new Error(`Prediction mismatch at sample ${index}: ${actual} != ${sample.expected}`);
  const probabilities = forest.predictProba(sample.features);
  for (const [label, expected] of Object.entries(sample.probabilities)) {
    const difference = Math.abs(probabilities[label] - expected);
    maxProbabilityDifference = Math.max(maxProbabilityDifference, difference);
    if (difference > 1e-9) throw new Error(`Probability mismatch at sample ${index}/${label}`);
  }
}
console.log(`Forest evaluator: ${samples.length}/${samples.length} predictions matched; max probability difference ${maxProbabilityDifference.toExponential(3)}.`);
for (const [group, count] of [...coverage.entries()].sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${group}: ${count}`);
