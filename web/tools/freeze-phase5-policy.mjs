import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const files = [
  'web/src/sim/engine.js', 'web/src/sim/roads.js', 'web/src/sim/features.js',
  'web/tools/phase5-benchmark.mjs',
  'web/src/sim/forest.js', 'web/src/sim/models.js',
  'web/public/models/move_side.json', 'web/public/models/corridor.json', 'web/public/models/eta.json',
];
const hashes = Object.fromEntries(files.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
writeFileSync(resolve(root, 'web/public/results/phase5-policy-freeze.json'), JSON.stringify({
  createdAt: new Date().toISOString(), benchmarkSeeds: '4001-4100', density: 'high', roadType: 'multilane', compliance: 0.88,
  policies: ['baseline', 'placeholder', 'ml', 'placeholder-move+ml-corridor'], hashes,
}, null, 2) + '\n', 'utf8');
console.log('Frozen policy and model hashes before reading benchmark seeds 4001-4100.');
for (const [path, hash] of Object.entries(hashes)) console.log(`${path}: ${hash}`);
