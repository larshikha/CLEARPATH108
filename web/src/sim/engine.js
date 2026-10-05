import { getRoad } from './roads.js';
import { corridorFeatures, etaFeatures, moveSideFeatures } from './features.js';
import { forests } from './models.js';

export const WORLD_LENGTH = 1200;
export const DT = 0.1;
export const AMBULANCE_FREE_SPEED = 18;
export const AMBULANCE_ACCELERATION = 3;
const DENSITIES = { low: 15, med: 40, high: 70 };
const VEHICLE_LENGTH = 4.5;
const AMBULANCE_LENGTH = 4.8;

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const randomBetween = (draw, min, max) => min + draw * (max - min);

function corridorRule(sim) {
  // Phase 1/4 comparison placeholder sizing policy.
  const laneFactor = sim.road.lanes === 2 ? 70 : 0;
  return Math.round(clamp(250 + sim.densityCount * 6 + laneFactor, 150, 600));
}

function usesMoveModel(sim) {
  return sim.movePolicy === 'ml';
}

function corridorPrediction(sim) {
  if (sim.mode === 'clearpath' && sim.corridorPolicy === 'ml') {
    return Math.round(clamp(forests.corridor.predict(corridorFeatures(sim)), 150, 600));
  }
  return corridorRule(sim);
}

function etaPrediction(sim) {
  const remaining = Math.max(0, WORLD_LENGTH - sim.ambulance.x);
  if (sim.finished || remaining === 0) return 0;
  if (sim.etaPolicy === 'ml') return Math.max(0, forests.eta.predict(etaFeatures(sim, remaining)));
  return remaining / Math.max(1, sim.ambulance.speed);
}

function makeVehicle(rng, id, lane, x, direction = 1, oncoming = false, crossTraffic = false) {
  const cruiseSpeed = 4 + rng() * 5;
  return {
    id, x, lane, speed: cruiseSpeed, cruiseSpeed, length: VEHICLE_LENGTH,
    state: 'cruising', alertTime: null, reactTime: null, action: 'NONE',
    direction, oncoming, crossTraffic,
    // The same per-vehicle draw is scaled into each mode's response-time range.
    reactionDraw: rng(), complianceDraw: rng(), compliance: null, clearpathAlerted: false, awaitingSiren: false, baselineFallback: false,
    confidence: null, explanation: '', holdingForPolicy: false, reEvaluateAt: null,
    lastReevaluationAt: null, waitingForGap: false, retryReason: null, stopStartedAt: null,
  };
}

function makeTraffic(density, road, rng) {
  const count = DENSITIES[density];
  const vehicles = [];
  const oncomingCount = road.oncomingLanes ? Math.max(1, Math.round(count * 0.25)) : 0;
  for (let i = 0; i < count; i += 1) {
    const lane = Math.floor(rng() * road.lanes);
    let x = 35 + rng() * (WORLD_LENGTH - 100);
    for (let attempt = 0; attempt < 100 && vehicles.some(v => !v.oncoming && !v.crossTraffic && v.lane === lane && Math.abs(v.x - x) < 10); attempt += 1) {
      x = 35 + rng() * (WORLD_LENGTH - 100);
    }
    vehicles.push(makeVehicle(rng, `v${i + 1}`, lane, x));
  }
  for (let i = 0; i < oncomingCount; i += 1) {
    const lane = road.lanes + Math.floor(rng() * road.oncomingLanes);
    let x = 35 + rng() * (WORLD_LENGTH - 100);
    for (let attempt = 0; attempt < 100 && vehicles.some(v => v.oncoming && v.lane === lane && Math.abs(v.x - x) < 10); attempt += 1) {
      x = 35 + rng() * (WORLD_LENGTH - 100);
    }
    vehicles.push(makeVehicle(rng, `o${i + 1}`, lane, x, -1, true));
  }
  if (road.junctionX !== null) {
    for (let i = 0; i < 2; i += 1) {
      vehicles.push(makeVehicle(rng, `c${i + 1}`, -1, road.junctionX - 12 + i * 24, 0, false, true));
    }
  }
  return vehicles;
}

export function createSim(config = {}) {
  const seed = Number.isInteger(config.seed) ? config.seed : 1;
  const density = config.density ?? 'med';
  if (!(density in DENSITIES)) throw new RangeError(`Unknown density: ${density}`);
  const mode = config.mode ?? 'clearpath';
  const compliance = config.compliance ?? 0.88;
  const policy = config.policy ?? (mode === 'baseline' ? 'placeholder' : 'hybrid');
  // Production CLEARPATH is the frozen hybrid: placeholder move-side actions,
  // with ML corridor sizing and ETA prediction. ML move-side remains experimental.
  const movePolicy = config.movePolicy ?? (policy === 'hybrid' ? 'placeholder' : policy);
  const corridorPolicy = config.corridorPolicy ?? (policy === 'ml' || policy === 'hybrid' ? 'ml' : 'placeholder');
  const etaPolicy = config.etaPolicy ?? (policy === 'ml' || policy === 'hybrid' ? 'ml' : 'placeholder');
  if (!Number.isFinite(compliance) || compliance < 0 || compliance > 1) throw new RangeError('compliance must be between 0 and 1');
  if (!['baseline', 'clearpath'].includes(mode)) throw new RangeError(`Unknown mode: ${mode}`);
  if (!['hybrid', 'ml', 'placeholder', 'label-rule', 'label-rule-retry'].includes(policy)) throw new RangeError(`Unknown policy: ${policy}`);
  if (!['ml', 'placeholder', 'label-rule', 'label-rule-retry'].includes(movePolicy)) throw new RangeError(`Unknown move policy: ${movePolicy}`);
  if (!['ml', 'placeholder'].includes(corridorPolicy) || !['ml', 'placeholder'].includes(etaPolicy)) throw new RangeError('corridorPolicy and etaPolicy must be ml or placeholder');
  const road = getRoad(config.roadType ?? 'multilane');
  const rng = mulberry32(seed);
  const ambulanceLane = config.ambulanceLane ?? Math.floor(road.lanes / 2);
  if (!Number.isInteger(ambulanceLane) || ambulanceLane < 0 || ambulanceLane >= road.lanes) {
    throw new RangeError(`ambulanceLane must be between 0 and ${road.lanes - 1}`);
  }
  const sim = {
    seed, density, densityCount: DENSITIES[density], mode, policy, movePolicy, corridorPolicy, etaPolicy, road, compliance,
    time: 0, dt: DT, finished: false,
    ambulance: { x: 0, lane: ambulanceLane, speed: 0 },
    vehicles: makeTraffic(density, road, rng), rng, corridorLen: 0,
    alertsSent: 0, alertsRequiringMove: 0, collisions: 0, collisionPairs: new Set(),
    blockedTime: 0, travelTime: null, clearanceEpisodes: [], activeClearance: null,
    stopVehicleIds: new Set(), stopDurations: [], stopLaneVehicleIds: new Set(), stopLaneVehicleSeconds: 0,
    stopLeadBlockerVehicleIds: new Set(), failedLaneChanges: 0, alertLeadDistances: [],
    captureBlockedTicks: config.captureBlockedTicks === true, capturePolicyName: config.capturePolicyName ?? null,
    blockedTickLog: config.captureBlockedTicks === true ? [] : null,
  };
  sim.corridorLen = corridorPrediction(sim);
  sim.corridorWindow = mode === 'baseline' ? 420 : sim.corridorLen;
  return sim;
}

function laneIsFree(sim, lane, x, excludeId, aheadGap = 15, behindGap = 10) {
  if (lane < 0 || lane >= sim.road.lanes) return false;
  const vehiclesClear = !sim.vehicles.some(v => !v.crossTraffic && !v.oncoming && v.id !== excludeId && v.lane === lane &&
    (v.x >= x ? v.x - x < aheadGap : x - v.x < behindGap));
  if (!vehiclesClear) return false;
  if (sim.ambulance.lane === lane && Math.abs(sim.ambulance.x - x) < (sim.ambulance.x >= x ? aheadGap : behindGap)) return false;
  return true;
}

function choosePlaceholderAction(sim, vehicle) {
  // Retained Phase 1 policy for parity comparisons.
  if (vehicle.crossTraffic) return 'STOP';
  let deltas;
  if (vehicle.lane < sim.ambulance.lane) deltas = [-1];
  else if (vehicle.lane > sim.ambulance.lane) deltas = [1];
  else deltas = [-1, 1];
  for (const delta of deltas) {
    if (laneIsFree(sim, vehicle.lane + delta, vehicle.x, vehicle.id)) return delta < 0 ? 'LEFT' : 'RIGHT';
  }
  return 'NONE';
}

function actionExplanation(sim, vehicle, action) {
  if (vehicle.crossTraffic) return action === 'STOP' ? 'Junction crossing · hold' : 'Junction clear';
  if (action === 'STOP') return 'Same lane · both side gaps under 15 m';
  if (action === 'LEFT') return 'Driver-left side · safe gap';
  if (action === 'RIGHT') return 'Driver-right side · safe gap';
  if (vehicle.lane !== sim.ambulance.lane) return 'Other lane · no move needed';
  return 'No slower same-lane blocker';
}

function chooseTrainingLabelAction(sim, vehicle) {
  if (vehicle.oncoming) return 'NONE';
  if (vehicle.crossTraffic) return sim.road.junctionX >= sim.ambulance.x ? 'STOP' : 'NONE';
  if (vehicle.lane !== sim.ambulance.lane || vehicle.x < sim.ambulance.x || vehicle.speed >= sim.ambulance.speed) return 'NONE';
  const features = moveSideFeatures(sim, vehicle);
  if (features.free_left >= 15) return 'LEFT';
  if (features.free_right >= 15) return 'RIGHT';
  return 'STOP';
}

function chooseClearpathAction(sim, vehicle) {
  if (vehicle.crossTraffic) {
    return { action: sim.road.junctionX >= sim.ambulance.x ? 'STOP' : 'NONE', confidence: null };
  }
  if (sim.movePolicy === 'label-rule' || sim.movePolicy === 'label-rule-retry') {
    return { action: chooseTrainingLabelAction(sim, vehicle), confidence: null };
  }
  if (usesMoveModel(sim)) {
    const features = moveSideFeatures(sim, vehicle);
    const action = forests.moveSide.predict(features);
    const probabilities = forests.moveSide.predictProba(features);
    return { action, confidence: probabilities[action] ?? 0 };
  }
  return { action: choosePlaceholderAction(sim, vehicle), confidence: null };
}

function chooseBaselineAction(sim, vehicle) {
  if (vehicle.crossTraffic) return 'STOP';
  const candidates = [vehicle.lane - 1, vehicle.lane + 1]
    .filter(lane => lane >= 0 && lane < sim.road.lanes)
    .sort((a, b) => Math.abs(a - vehicle.lane) - Math.abs(b - vehicle.lane));
  // Drivers already outside the ambulance lane keep moving farther away from it.
  const safeCandidates = vehicle.lane === sim.ambulance.lane ? candidates : candidates.filter(lane => lane !== sim.ambulance.lane);
  for (const lane of safeCandidates) {
    if (laneIsFree(sim, lane, vehicle.x, vehicle.id)) return lane < vehicle.lane ? 'LEFT' : 'RIGHT';
  }
  return 'AUTO';
}

function startBaselineReaction(sim, vehicle) {
  vehicle.baselineFallback = true;
  vehicle.awaitingSiren = false;
  vehicle.alertTime = sim.time;
  vehicle.reactTime = randomBetween(vehicle.reactionDraw, 3, 6);
  vehicle.action = 'AUTO';
  vehicle.confidence = null;
  vehicle.explanation = 'Baseline siren response';
}

function startAlert(sim, vehicle) {
  vehicle.state = 'alerted';
  vehicle.alertTime = sim.time;
  vehicle.lastReevaluationAt = sim.time;
  if (sim.mode === 'baseline') {
    startBaselineReaction(sim, vehicle);
    return;
  }
  vehicle.clearpathAlerted = true;
  vehicle.lastReevaluationAt = sim.time;
  vehicle.compliance = vehicle.complianceDraw < sim.compliance;
  const response = chooseClearpathAction(sim, vehicle);
  vehicle.action = response.action;
  vehicle.confidence = response.confidence;
  vehicle.explanation = actionExplanation(sim, vehicle, response.action);
  sim.alertsSent += 1;
  sim.alertLeadDistances.push(Math.max(0, vehicle.x - sim.ambulance.x));
  if (['LEFT', 'RIGHT'].includes(vehicle.action)) sim.alertsRequiringMove += 1;
  if (vehicle.compliance) {
    vehicle.reactTime = randomBetween(vehicle.reactionDraw, 1, 2);
  } else {
    // Ignore the V2V instruction; use the baseline siren response if it comes within 100 m.
    vehicle.awaitingSiren = true;
    vehicle.reactTime = null;
  }
}

function alertVehicles(sim) {
  for (const vehicle of sim.vehicles) {
    if (vehicle.oncoming) continue;
    if (vehicle.awaitingSiren) {
      if (!vehicle.crossTraffic) {
        const ahead = vehicle.x - sim.ambulance.x;
        if (ahead > 0 && ahead <= 100) startBaselineReaction(sim, vehicle);
      }
      continue;
    }
    if (vehicle.state !== 'cruising' || (sim.mode === 'clearpath' && vehicle.clearpathAlerted)) continue;
    if (vehicle.crossTraffic) {
      if (sim.mode === 'clearpath' && sim.road.junctionX !== null && Math.abs(vehicle.x - sim.road.junctionX) <= 30 &&
          sim.road.junctionX - sim.ambulance.x <= sim.corridorLen && sim.road.junctionX >= sim.ambulance.x) startAlert(sim, vehicle);
      continue;
    }
    const ahead = vehicle.x - sim.ambulance.x;
    if (ahead <= 0) continue;
    const inPath = vehicle.lane === sim.ambulance.lane || Math.abs(vehicle.lane - sim.ambulance.lane) === 1;
    const shouldAlert = sim.mode === 'baseline' ? ahead <= 100 : ahead <= sim.corridorLen && inPath;
    if (shouldAlert) startAlert(sim, vehicle);
  }
}

function applyClearpathResponse(sim, vehicle, response) {
  vehicle.lastReevaluationAt = sim.time;
  vehicle.waitingForGap = false;
  vehicle.retryReason = null;
  vehicle.action = response.action;
  vehicle.confidence = response.confidence;
  vehicle.explanation = actionExplanation(sim, vehicle, response.action);
  if (vehicle.stopStartedAt !== null && response.action !== 'STOP') {
    sim.stopDurations.push(Math.max(0, sim.time - vehicle.stopStartedAt));
    vehicle.stopStartedAt = null;
  }
  vehicle.holdingForPolicy = false;
  vehicle.retryCruisingForPolicy = false;
  vehicle.reEvaluateAt = null;
  if (response.action === 'STOP') {
    if (sim.movePolicy === 'label-rule-retry') {
      // Evaluation variant: replace STOP with cruising and retry the same label rule every 0.5 s.
      vehicle.state = 'moving';
      vehicle.speed = vehicle.cruiseSpeed;
      vehicle.retryCruisingForPolicy = true;
      vehicle.reEvaluateAt = sim.time + 0.5;
      vehicle.action = 'RETRY';
      return;
    }
    if (vehicle.stopStartedAt === null) vehicle.stopStartedAt = sim.time;
    sim.stopVehicleIds.add(vehicle.id);
    vehicle.waitingForGap = true;
    vehicle.state = 'stopped';
    vehicle.speed = 0;
    vehicle.holdingForPolicy = true;
    vehicle.reEvaluateAt = sim.time + 0.5;
    return;
  }
  if (response.action === 'NONE' && !vehicle.crossTraffic) {
    // Placeholder and model policies both retry NONE on the next simulation tick.
    const noSideGap = !laneIsFree(sim, vehicle.lane - 1, vehicle.x, vehicle.id) &&
      !laneIsFree(sim, vehicle.lane + 1, vehicle.x, vehicle.id);
    vehicle.waitingForGap = noSideGap;
    vehicle.retryReason = noSideGap ? 'NO_GAP' : 'NONE';
    vehicle.state = 'alerted';
    return;
  }
  const target = response.action === 'LEFT' ? vehicle.lane - 1 : response.action === 'RIGHT' ? vehicle.lane + 1 : null;
  if (target === null) {
    vehicle.state = 'moving';
    return;
  }
  if (laneIsFree(sim, target, vehicle.x, vehicle.id)) {
    vehicle.lane = target;
    vehicle.state = 'moving';
    return;
  }
  sim.failedLaneChanges += 1;
  // A stale move prediction follows the same retry path as placeholder NONE:
  // keep cruising safely and re-evaluate on the next fixed-dt tick.
  vehicle.waitingForGap = true;
  vehicle.retryReason = 'NO_GAP';
  vehicle.action = 'NONE';
  vehicle.state = 'alerted';
}

function applyReactions(sim) {
  for (const vehicle of sim.vehicles) {
    if (vehicle.holdingForPolicy || vehicle.retryCruisingForPolicy) {
      if (sim.time + 1e-9 < vehicle.reEvaluateAt) continue;
      applyClearpathResponse(sim, vehicle, chooseClearpathAction(sim, vehicle));
      continue;
    }
    if (vehicle.state !== 'alerted' || vehicle.awaitingSiren || vehicle.reactTime === null ||
        sim.time - vehicle.alertTime + 1e-9 < vehicle.reactTime) continue;
    vehicle.lastReevaluationAt = sim.time;
    if (vehicle.baselineFallback || sim.mode === 'baseline') {
      vehicle.action = chooseBaselineAction(sim, vehicle);
      const target = vehicle.action === 'LEFT' ? vehicle.lane - 1 : vehicle.action === 'RIGHT' ? vehicle.lane + 1 : null;
      if (target !== null && laneIsFree(sim, target, vehicle.x, vehicle.id)) {
        vehicle.lane = target;
        vehicle.state = 'moving';
      } else if (target !== null) {
        sim.failedLaneChanges += 1;
      }
      continue;
    }
    applyClearpathResponse(sim, vehicle, chooseClearpathAction(sim, vehicle));
  }
}

function closeOpenStops(sim) {
  for (const vehicle of sim.vehicles) {
    if (vehicle.stopStartedAt === null) continue;
    sim.stopDurations.push(Math.max(0, sim.time - vehicle.stopStartedAt));
    vehicle.stopStartedAt = null;
  }
}

function updateVehicleSpeeds(sim) {
  const lanes = new Map();
  for (const vehicle of sim.vehicles) {
    if (vehicle.crossTraffic || vehicle.oncoming || vehicle.direction !== 1 || vehicle.lane >= sim.road.lanes) continue;
    if (!lanes.has(vehicle.lane)) lanes.set(vehicle.lane, []);
    lanes.get(vehicle.lane).push(vehicle);
  }
  for (const laneVehicles of lanes.values()) {
    laneVehicles.sort((a, b) => b.x - a.x);
    let front = null;
    for (const vehicle of laneVehicles) {
      if (vehicle.state === 'stopped') vehicle.speed = 0;
      else if (!front) vehicle.speed = vehicle.cruiseSpeed;
      else {
        const bumperGap = front.x - vehicle.x - (front.length + vehicle.length) / 2;
        // Preserve a small safe gap while allowing the follower to recover cruise speed.
        const safeSpeed = front.speed + Math.max(0, (bumperGap - 4) * 0.5);
        vehicle.speed = Math.min(vehicle.cruiseSpeed, safeSpeed);
      }
      front = vehicle;
    }
  }
  for (const vehicle of sim.vehicles) {
    if (vehicle.crossTraffic) vehicle.speed = vehicle.state === 'stopped' ? 0 : vehicle.cruiseSpeed;
    else if (vehicle.oncoming) vehicle.speed = vehicle.cruiseSpeed;
    else if (vehicle.lane >= sim.road.lanes) vehicle.speed = vehicle.cruiseSpeed;
  }
}

function blockingVehicles(sim) {
  return sim.vehicles.filter(v => !v.crossTraffic && !v.oncoming && v.direction === 1 && v.lane === sim.ambulance.lane &&
    v.x >= sim.ambulance.x && v.x <= sim.ambulance.x + sim.corridorWindow && v.speed < sim.ambulance.speed);
}

function updateClearance(sim) {
  const blockers = blockingVehicles(sim);
  if (!sim.activeClearance && blockers.length) sim.activeClearance = { startedAt: sim.time };
  if (sim.activeClearance && !blockers.length) {
    sim.clearanceEpisodes.push(Math.max(0, sim.time - sim.activeClearance.startedAt));
    sim.activeClearance = null;
  }
}

function recordStopLaneExposure(sim) {
  const stoppedInAmbulanceLane = sim.vehicles.filter(vehicle => vehicle.stopStartedAt !== null &&
    vehicle.lane === sim.ambulance.lane);
  for (const vehicle of stoppedInAmbulanceLane) {
    sim.stopLaneVehicleIds.add(vehicle.id);
    sim.stopLaneVehicleSeconds += sim.dt;
  }
  const lead = sim.vehicles.filter(vehicle => !vehicle.crossTraffic && !vehicle.oncoming &&
    vehicle.direction === 1 && vehicle.lane === sim.ambulance.lane && vehicle.x >= sim.ambulance.x)
    .sort((a, b) => a.x - b.x)[0];
  if (lead && lead.stopStartedAt !== null && lead.speed < sim.ambulance.speed) {
    sim.stopLeadBlockerVehicleIds.add(lead.id);
  }
}

function recordBlockedTick(sim, lead) {
  if (!sim.captureBlockedTicks) return;
  const leadIsBlocker = lead && lead.x >= sim.ambulance.x && lead.speed < sim.ambulance.speed;
  const noSideGap = lead && !lead.crossTraffic &&
    !laneIsFree(sim, lead.lane - 1, lead.x, lead.id) && !laneIsFree(sim, lead.lane + 1, lead.x, lead.id);
  sim.blockedTickLog.push({
    seed: sim.seed, policy: sim.capturePolicyName ?? (sim.mode === 'baseline' ? 'baseline' : sim.policy),
    movePolicy: sim.mode === 'baseline' ? 'baseline' : sim.movePolicy,
    time: sim.time, ambulanceX: sim.ambulance.x, ambulanceLane: sim.ambulance.lane,
    ambulanceSpeed: sim.ambulance.speed,
    leadBlockerId: lead?.id ?? '', leadAction: lead?.action ?? '', leadState: lead?.state ?? '',
    lastReevaluationTime: lead?.lastReevaluationAt ?? '',
    waitingForGap: Boolean(lead?.waitingForGap || (leadIsBlocker && noSideGap)),
    retryReason: lead?.retryReason ?? '', reEvaluateAt: lead?.reEvaluateAt ?? '',
    gapLeftFree: lead && !lead.crossTraffic ? laneIsFree(sim, lead.lane - 1, lead.x, lead.id) : false,
    gapRightFree: lead && !lead.crossTraffic ? laneIsFree(sim, lead.lane + 1, lead.x, lead.id) : false,
  });
}

function recordCollisions(sim) {
  const laneVehicles = new Map();
  for (const vehicle of sim.vehicles) {
    if (vehicle.crossTraffic) continue;
    const key = String(vehicle.lane);
    if (!laneVehicles.has(key)) laneVehicles.set(key, []);
    laneVehicles.get(key).push(vehicle);
  }
  for (const [lane, vehicles] of laneVehicles) {
    vehicles.sort((a, b) => a.x - b.x);
    for (let i = 1; i < vehicles.length; i += 1) {
      const rear = vehicles[i - 1];
      const front = vehicles[i];
      if (front.x - rear.x < (front.length + rear.length) / 2) {
        const key = `${lane}:${rear.id}:${front.id}`;
        if (!sim.collisionPairs.has(key)) { sim.collisionPairs.add(key); sim.collisions += 1; }
      }
    }
  }
  for (const vehicle of sim.vehicles) {
    if (vehicle.crossTraffic || vehicle.oncoming || vehicle.lane !== sim.ambulance.lane) continue;
    if (Math.abs(vehicle.x - sim.ambulance.x) < (vehicle.length + AMBULANCE_LENGTH) / 2) {
      const key = `ambulance:${vehicle.id}`;
      if (!sim.collisionPairs.has(key)) { sim.collisionPairs.add(key); sim.collisions += 1; }
    }
  }
}

export function step(sim) {
  if (sim.finished) return getState(sim);
  if (sim.mode === 'clearpath') {
    sim.corridorLen = corridorPrediction(sim);
    sim.corridorWindow = sim.corridorLen;
  }
  alertVehicles(sim);
  // Start an episode before a vehicle reacts, so a successful immediate clearing is recorded.
  updateClearance(sim);
  applyReactions(sim);
  updateVehicleSpeeds(sim);
  recordStopLaneExposure(sim);

  const ahead = sim.vehicles.filter(v => !v.oncoming && !v.crossTraffic && v.direction === 1 && v.lane === sim.ambulance.lane && v.x >= sim.ambulance.x)
    .sort((a, b) => a.x - b.x)[0];
  const freeRunSpeed = Math.min(AMBULANCE_FREE_SPEED, sim.ambulance.speed + AMBULANCE_ACCELERATION * sim.dt);
  if (ahead) {
    const bumperGap = ahead.x - sim.ambulance.x - (ahead.length + AMBULANCE_LENGTH) / 2;
    sim.ambulance.speed = bumperGap < 12 ? Math.min(freeRunSpeed, ahead.speed) : freeRunSpeed;
  } else sim.ambulance.speed = freeRunSpeed;
  if (sim.ambulance.speed < AMBULANCE_FREE_SPEED * 0.9) {
    sim.blockedTime += sim.dt;
    recordBlockedTick(sim, ahead);
  }

  for (const vehicle of sim.vehicles) vehicle.x += vehicle.direction * vehicle.speed * sim.dt;
  sim.ambulance.x += sim.ambulance.speed * sim.dt;
  sim.time = Number((sim.time + sim.dt).toFixed(10));
  if (!sim.rolloutMode) {
    recordCollisions(sim);
    updateClearance(sim);
  }

  if (sim.ambulance.x >= WORLD_LENGTH) {
    sim.ambulance.x = WORLD_LENGTH;
    sim.finished = true;
    sim.travelTime = sim.time;
    if (sim.activeClearance) {
      sim.clearanceEpisodes.push(Math.max(0, sim.time - sim.activeClearance.startedAt));
      sim.activeClearance = null;
    }
    closeOpenStops(sim);
  }
  return sim.rolloutMode ? undefined : getState(sim);
}

export function isFinished(sim) { return sim.finished; }

export function getState(sim) {
  const episodes = sim.clearanceEpisodes;
  const clearanceTime = episodes.length ? episodes.reduce((sum, duration) => sum + duration, 0) / episodes.length : 0;
  const meanStopTime = sim.stopDurations.length ? sim.stopDurations.reduce((sum, duration) => sum + duration, 0) / sim.stopDurations.length : 0;
  const meanAlertLeadDistance = sim.alertLeadDistances.length ? sim.alertLeadDistances.reduce((sum, distance) => sum + distance, 0) / sim.alertLeadDistances.length : null;
  return {
    time: sim.time, dt: sim.dt, finished: sim.finished, compliance: sim.compliance,
    road: { ...sim.road }, mode: sim.mode, policy: sim.policy, movePolicy: sim.movePolicy,
    corridorPolicy: sim.corridorPolicy, etaPolicy: sim.etaPolicy, seed: sim.seed, density: sim.density,
    ambulance: { ...sim.ambulance }, vehicles: sim.vehicles.map(vehicle => ({ ...vehicle })),
    corridorLen: sim.corridorLen, etaToDestination: etaPrediction(sim),
    metrics: {
      travelTime: sim.travelTime, clearanceTime, clearanceEpisodeCount: episodes.length,
      clearanceEpisodes: [...episodes], blockedTime: sim.blockedTime,
      alertsSent: sim.alertsSent, alertsRequiringMove: sim.alertsRequiringMove, collisions: sim.collisions,
      stopVehicleCount: sim.stopVehicleIds.size, stopEpisodes: sim.stopDurations.length, meanStopTime,
      stopLaneVehicleCount: sim.stopLaneVehicleIds.size,
      stopLaneVehicleSeconds: sim.stopLaneVehicleSeconds,
      meanStopTimeInAmbulanceLane: sim.stopLaneVehicleIds.size ? sim.stopLaneVehicleSeconds / sim.stopLaneVehicleIds.size : 0,
      stopVehiclesEverLeadBlocker: sim.stopLeadBlockerVehicleIds.size,
      stopLeadBlockerShare: sim.stopVehicleIds.size ? sim.stopLeadBlockerVehicleIds.size / sim.stopVehicleIds.size : 0,
      failedLaneChanges: sim.failedLaneChanges, meanAlertLeadDistance,
      blockedTickCount: sim.blockedTickLog?.length ?? 0,
    },
  };
}
