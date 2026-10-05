import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim, isFinished, step, WORLD_LENGTH } from '../src/sim/engine.js';
import { corridorFeatures, etaFeatures, moveSideFeatures, MOVE_SIDE_FEATURE_NAMES } from '../src/sim/features.js';
import { getRoadTypes } from '../src/sim/roads.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const densityNames = ['low', 'med', 'high'];
const supportedRoads = getRoadTypes();
const trainSeeds = Array.from({ length: 400 }, (_, i) => i + 1);
const testSeeds = Array.from({ length: 100 }, (_, i) => i + 1001);
const snapshotInterval = 2; // Keep the established Phase 3 snapshot cadence.
const moveColumns = [...MOVE_SIDE_FEATURE_NAMES, 'action', 'row_type', 'road_type', 'seed'];
const corridorColumns = ['amb_speed', 'density', 'road_type_code', 'n_lanes', 'slower_ahead_150m', 'corridor_len', 'road_type', 'seed'];
const etaColumns = ['remaining_dist', 'amb_speed', 'density', 'road_type_code', 'slower_ahead_150m', 'actual_time_to_go', 'road_type', 'seed'];
const counts = Object.fromEntries(['train', 'test'].map(split => [split, {
  move: { total: 0, categories: {}, actions: Object.fromEntries(['LEFT', 'RIGHT', 'STOP', 'NONE'].map(a => [a, 0])) },
  corridor: 0, eta: 0,
}]));
const handles = {};

function csv(rows, columns) {
  const quote = value => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return rows.length ? rows.map(row => columns.map(column => quote(row[column])).join(',')).join('\n') + '\n' : '';
}

for (const split of ['train', 'test']) {
  const folder = resolve(root, 'data', split);
  mkdirSync(folder, { recursive: true });
  handles[split] = {};
  for (const [name, columns] of [['move', moveColumns], ['corridor', corridorColumns], ['eta', etaColumns]]) {
    const path = resolve(folder, name === 'move' ? 'move_side.csv' : `${name}.csv`);
    const fd = openSync(path, 'w');
    writeSync(fd, columns.join(',') + '\n');
    handles[split][name] = fd;
  }
}

function seededLane(seed, densityIndex, roadIndex, laneCount) {
  return (seed * 17 + densityIndex * 7 + roadIndex * 11) % laneCount;
}

function gapToLane(sim, vehicle, lane) {
  if (lane < 0 || lane >= sim.road.lanes) return 0;
  let nearest = Infinity;
  for (const other of sim.vehicles) {
    if (other.id === vehicle.id || other.oncoming || other.crossTraffic || other.lane !== lane) continue;
    nearest = Math.min(nearest, Math.abs(other.x - vehicle.x));
  }
  if (sim.ambulance.lane === lane) nearest = Math.min(nearest, Math.abs(sim.ambulance.x - vehicle.x));
  return Number.isFinite(nearest) ? nearest : 1200;
}

function cloneForRollout(sim) {
  return {
    ...sim,
    rolloutMode: true,
    road: { ...sim.road },
    ambulance: { ...sim.ambulance },
    vehicles: sim.vehicles.map(vehicle => ({ ...vehicle })),
    clearanceEpisodes: [...sim.clearanceEpisodes],
    activeClearance: sim.activeClearance ? { ...sim.activeClearance } : null,
    collisionPairs: new Set(sim.collisionPairs),
    stopVehicleIds: new Set(sim.stopVehicleIds),
    stopDurations: [...sim.stopDurations],
    stopLaneVehicleIds: new Set(sim.stopLaneVehicleIds),
    stopLeadBlockerVehicleIds: new Set(sim.stopLeadBlockerVehicleIds),
    alertLeadDistances: [...sim.alertLeadDistances],
    mode: 'clearpath', policy: 'placeholder', movePolicy: 'placeholder',
    corridorPolicy: 'placeholder', etaPolicy: 'placeholder', compliance: 1,
    corridorWindow: sim.corridorLen, jointRollout: true, rolloutTargetId: null,
  };
}

function rolloutProgress(sim, vehicleId, candidateAction) {
  const rollout = cloneForRollout(sim);
  const controlled = rollout.vehicles.find(vehicle => vehicle.id === vehicleId);
  rollout.rolloutTargetId = vehicleId;
  // Convert pending baseline siren responses into fresh CLEARPATH alerts so all
  // non-target drivers use the placeholder policy during this joint rollout.
  for (const other of rollout.vehicles) {
    if (other.id === vehicleId) continue;
    other.baselineFallback = false;
    other.awaitingSiren = false;
    if (other.state === 'alerted') {
      other.state = 'cruising'; other.action = 'NONE'; other.alertTime = null;
      other.reactTime = null; other.clearpathAlerted = false;
    }
  }
  let nextTry = rollout.time;
  controlled.state = candidateAction === 'HOLD-AND-RETRY' ? 'stopped' : 'moving';
  controlled.awaitingSiren = false;
  controlled.baselineFallback = false;
  controlled.clearpathAlerted = true;
  controlled.action = candidateAction === 'HOLD-AND-RETRY' ? 'STOP' : candidateAction;
  controlled.holdingForPolicy = false;
  controlled.retryCruisingForPolicy = false;
  controlled.stopStartedAt = null;
  const startX = rollout.ambulance.x;
  const startTime = rollout.time;
  const duration = 10;
  while (!isFinished(rollout) && rollout.time - startTime < duration - 1e-9) {
    if (candidateAction === 'LEFT' || candidateAction === 'RIGHT' || candidateAction === 'HOLD-AND-RETRY') {
      if (rollout.time + 1e-9 >= nextTry) {
        const deltas = candidateAction === 'HOLD-AND-RETRY'
          ? [-1, 1]
          : [candidateAction === 'LEFT' ? -1 : 1];
        const targetDelta = deltas.find(delta => laneIsClear(rollout, controlled, controlled.lane + delta));
        if (targetDelta !== undefined) {
          controlled.lane += targetDelta;
          controlled.state = 'moving';
          controlled.speed = controlled.cruiseSpeed;
          controlled.retryCruisingForPolicy = false;
          controlled.holdingForPolicy = false;
        } else if (candidateAction === 'HOLD-AND-RETRY') {
          controlled.state = 'stopped';
        } else {
          controlled.state = 'moving';
        }
        nextTry += 0.5;
      }
    }
    step(rollout);
  }
  return rollout.ambulance.x - startX;
}

function laneIsClear(sim, vehicle, lane) {
  if (lane < 0 || lane >= sim.road.lanes) return false;
  return !sim.vehicles.some(other => other.id !== vehicle.id && !other.crossTraffic && !other.oncoming && other.lane === lane &&
    (other.x >= vehicle.x ? other.x - vehicle.x < 15 : vehicle.x - other.x < 10)) &&
    !(sim.ambulance.lane === lane && (sim.ambulance.x >= vehicle.x ? sim.ambulance.x - vehicle.x < 15 : vehicle.x - sim.ambulance.x < 10));
}

function rolloutDecisionLabel(sim, vehicle) {
  const candidates = ['LEFT', 'RIGHT', 'HOLD-AND-RETRY', 'NONE'];
  const results = candidates.map(action => ({ action, progress: rolloutProgress(sim, vehicle.id, action) }));
  const bestProgress = Math.max(...results.map(result => result.progress));
  const tied = results.filter(result => Math.abs(result.progress - bestProgress) <= 1e-6);
  const safeLeft = laneIsClear(sim, vehicle, vehicle.lane - 1);
  const safeRight = laneIsClear(sim, vehicle, vehicle.lane + 1);
  // Equal-delay outcomes prefer the closest currently free adjacent lane, left first.
  const tieOrder = [
    ...(safeLeft ? ['LEFT'] : []),
    ...(safeRight ? ['RIGHT'] : []),
    'NONE', 'HOLD-AND-RETRY',
    ...(!safeLeft ? ['LEFT'] : []), ...(!safeRight ? ['RIGHT'] : []),
  ];
  const winner = tieOrder.find(action => tied.some(result => result.action === action)) ?? tied[0].action;
  return winner === 'HOLD-AND-RETRY' ? 'STOP' : winner;
}

function labelVehicle(sim, vehicle) {
  if (vehicle.oncoming) return { action: 'NONE', row_type: 'ONCOMING' };
  if (vehicle.crossTraffic) return {
    action: sim.road.junctionX >= sim.ambulance.x ? 'STOP' : 'NONE', row_type: 'JUNCTION_CROSS'
  };
  if (vehicle.lane !== sim.ambulance.lane) return { action: 'NONE', row_type: 'OTHER' };
  const isBlocking = vehicle.x >= sim.ambulance.x && vehicle.speed < sim.ambulance.speed;
  if (!isBlocking) return { action: 'NONE', row_type: 'DECISION' };
  return { action: rolloutDecisionLabel(sim, vehicle), row_type: 'DECISION' };
}
function appendScenario(split, rows) {
  writeSync(handles[split].move, csv(rows.move, moveColumns));
  writeSync(handles[split].corridor, csv(rows.corridor, corridorColumns));
  writeSync(handles[split].eta, csv(rows.eta, etaColumns));
  const target = counts[split];
  target.move.total += rows.move.length;
  target.corridor += rows.corridor.length;
  target.eta += rows.eta.length;
  for (const row of rows.move) {
    target.move.actions[row.action] += 1;
    if (!target.move.categories[row.row_type]) {
      target.move.categories[row.row_type] = Object.fromEntries(['LEFT', 'RIGHT', 'STOP', 'NONE'].map(action => [action, 0]));
    }
    target.move.categories[row.row_type][row.action] += 1;
  }
}

function runScenario(split, seed, density, road, densityIndex, roadIndex) {
  // Compliance is 1 in data runs so labels express the selected action.
  const lane = seededLane(seed, densityIndex, roadIndex, road.lanes);
  const sim = createSim({ seed, density, roadType: road.id, ambulanceLane: lane, mode: 'baseline', compliance: 1 });
  const rows = { move: [], corridor: [], eta: [] };
  const etaSnapshots = [];
  let nextSnapshot = snapshotInterval;
  let snapshotIndex = 0;
  let ticks = 0;
  while (!isFinished(sim) && ticks < 100000) {
    step(sim);
    ticks += 1;
    if (sim.time + 1e-9 < nextSnapshot) continue;

    // Snapshot moving states every ~2 seconds, never just the stopped initial state.
    const mainLaneVehicles = sim.vehicles.filter(vehicle => !vehicle.oncoming && !vehicle.crossTraffic);
    const decisionVehicles = mainLaneVehicles.filter(vehicle => vehicle.lane === sim.ambulance.lane);
    const otherLaneVehicles = mainLaneVehicles.filter(vehicle => vehicle.lane !== sim.ambulance.lane);
    const oncomingVehicles = sim.vehicles.filter(vehicle => vehicle.oncoming);
    const crossVehicles = sim.vehicles.filter(vehicle => vehicle.crossTraffic);
    const sampledDecisions = [];
    for (let i = 0; i < Math.min(2, decisionVehicles.length); i += 1) {
      sampledDecisions.push(decisionVehicles[(snapshotIndex * 2 + i) % decisionVehicles.length]);
    }
    const sampledVehicles = [
      ...sampledDecisions,
      ...(otherLaneVehicles.length ? [otherLaneVehicles[snapshotIndex % otherLaneVehicles.length]] : []),
      ...(oncomingVehicles.length ? [oncomingVehicles[snapshotIndex % oncomingVehicles.length]] : []),
      ...crossVehicles,
    ];
    for (const vehicle of sampledVehicles) {
      rows.move.push({ ...moveSideFeatures(sim, vehicle), ...labelVehicle(sim, vehicle),
        road_type: sim.road.id, seed });
    }
    const remaining = Math.max(0, WORLD_LENGTH - sim.ambulance.x);
    etaSnapshots.push({ time: sim.time, features: etaFeatures(sim, remaining) });
    rows.corridor.push({ ...corridorFeatures(sim), corridor_len: sim.corridorLen, road_type: road.id, seed });
    snapshotIndex += 1;
    nextSnapshot += snapshotInterval;
  }
  if (!isFinished(sim)) throw new Error(`Scenario ${road.id}/${density}/${seed} exceeded tick limit`);
  for (const snapshot of etaSnapshots) {
    rows.eta.push({ ...snapshot.features, actual_time_to_go: Math.max(0, sim.travelTime - snapshot.time), road_type: road.id, seed });
  }
  appendScenario(split, rows);
}

try {
  for (const [split, seeds] of [['train', trainSeeds], ['test', testSeeds]]) {
    let scenarioCount = 0;
    for (let roadIndex = 0; roadIndex < supportedRoads.length; roadIndex += 1) {
      const road = supportedRoads[roadIndex];
      for (let densityIndex = 0; densityIndex < densityNames.length; densityIndex += 1) {
        const density = densityNames[densityIndex];
        for (const seed of seeds) {
          runScenario(split, seed, density, road, densityIndex, roadIndex);
          scenarioCount += 1;
          if (scenarioCount % 100 === 0) console.log(`${split}: ${scenarioCount} scenarios processed`);
        }
      }
    }
    console.log(`${split}: generated ${scenarioCount} scenarios from seeds ${split === 'train' ? '1-400' : '1001-1100'}`);
  }
} finally {
  for (const split of ['train', 'test']) for (const fd of Object.values(handles[split])) closeSync(fd);
}

for (const split of ['train', 'test']) {
  const summary = counts[split];
  console.log(`${split}: move_side=${summary.move.total}, corridor=${summary.corridor}, eta=${summary.eta}`);
  console.log(`${split} move-side categories:`, summary.move.categories);
  console.log(`${split} move-side classes:`, summary.move.actions);
}
const training = counts.train.move;
console.log('\nTraining class balance by row category:');
for (const category of ['DECISION', 'OTHER', 'ONCOMING', 'JUNCTION_CROSS']) {
  const categoryCounts = training.categories[category] ?? Object.fromEntries(['LEFT', 'RIGHT', 'STOP', 'NONE'].map(action => [action, 0]));
  const categoryTotal = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0);
  console.log(`${category} (${categoryTotal} rows):`);
  for (const action of ['LEFT', 'RIGHT', 'STOP', 'NONE']) {
    const count = categoryCounts[action];
    console.log(`  ${action}: ${count} (${categoryTotal ? (count / categoryTotal * 100).toFixed(2) : '0.00'}%)`);
  }
}
const total = training.total;
for (const action of ['LEFT', 'RIGHT', 'STOP', 'NONE']) console.log(`${action}: ${training.actions[action]} (${(training.actions[action] / total * 100).toFixed(2)}%)`);
const rare = ['NONE', 'STOP'].filter(action => training.actions[action] / total < 0.05);
if (rare.length) console.log(`CLASS BALANCE GATE: ${rare.join(' and ')} below 5%; stop before training and review labels.`);
else console.log('CLASS BALANCE GATE: NONE and STOP are both at least 5%; training may proceed.');
