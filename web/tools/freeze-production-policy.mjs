import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const files = [
  'web/src/sim/engine.js', 'web/src/sim/roads.js', 'web/src/sim/features.js',
  'web/public/models/corridor.json', 'web/public/models/eta.json',
  'web/public/models/move_side.json', 'web/tools/production-benchmark-config.json',
];
const hashes = Object.fromEntries(files.map(path => [path,
  createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
const freeze = {
  createdAt: new Date().toISOString(),
  policy: 'hybrid',
  policyNames: { baseline: 'Baseline (no CLEARPATH alerts)', clearpath: 'CLEARPATH hybrid (placeholder move-side + ML corridor/ETA)' },
  configFile: 'web/tools/production-benchmark-config.json',
  config: JSON.parse(readFileSync(resolve(root, 'web/tools/production-benchmark-config.json'), 'utf8')),
  hashes,
};
writeFileSync(resolve(root, 'web/public/results/production-policy-freeze.json'), JSON.stringify(freeze, null, 2) + '\n', 'utf8');
console.log('Frozen simulator inputs, model JSONs and benchmark config before evaluating seeds 5001-5100.');
for (const [path, hash] of Object.entries(hashes)) console.log(`${path}: ${hash}`);
