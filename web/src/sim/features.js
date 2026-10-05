export const ROAD_TYPE_CODES = Object.freeze({ multilane: 0, divided: 1, junction: 3 });

export const MOVE_SIDE_FEATURE_NAMES = Object.freeze([
  'dist_to_amb', 'lane_offset', 'same_lane', 'lane_idx', 'n_lanes',
  'is_oneway', 'has_median', 'has_shoulder', 'junction_dist',
  'free_left', 'free_right', 'veh_speed', 'amb_speed', 'density', 'oncoming',
]);

export const CORRIDOR_FEATURE_NAMES = Object.freeze(['amb_speed', 'density', 'road_type_code', 'n_lanes', 'slower_ahead_150m']);
export const ETA_FEATURE_NAMES = Object.freeze(['remaining_dist', 'amb_speed', 'density', 'road_type_code', 'slower_ahead_150m']);

function localDensity(sim, x) {
  return sim.vehicles.filter(vehicle => !vehicle.crossTraffic && Math.abs(vehicle.x - x) <= 50).length;
}

function freeSpace(sim, lane, x, vehicleId) {
  if (lane < 0 || lane >= sim.road.lanes) return 0;
  let nearest = Infinity;
  for (const other of sim.vehicles) {
    if (other.id !== vehicleId && !other.crossTraffic && !other.oncoming && other.lane === lane) {
      nearest = Math.min(nearest, Math.abs(other.x - x));
    }
  }
  if (sim.ambulance.lane === lane) nearest = Math.min(nearest, Math.abs(sim.ambulance.x - x));
  return Number.isFinite(nearest) ? Math.min(1200, nearest) : 1200;
}

function slowerVehiclesAhead(sim) {
  return sim.vehicles.filter(vehicle => !vehicle.crossTraffic && !vehicle.oncoming &&
    vehicle.direction === 1 && vehicle.lane === sim.ambulance.lane &&
    vehicle.x > sim.ambulance.x && vehicle.x <= sim.ambulance.x + 150 &&
    vehicle.speed < sim.ambulance.speed).length;
}

export function moveSideFeatures(sim, vehicle) {
  const sameLane = !vehicle.oncoming && !vehicle.crossTraffic && vehicle.lane === sim.ambulance.lane;
  const junctionDist = sim.road.junctionX === null ? 999 : Math.abs(vehicle.x - sim.road.junctionX);
  const laneOffset = vehicle.lane - sim.ambulance.lane;
  return {
    dist_to_amb: vehicle.x - sim.ambulance.x,
    lane_offset: laneOffset,
    same_lane: sameLane ? 1 : 0,
    lane_idx: vehicle.lane,
    n_lanes: sim.road.lanes,
    is_oneway: sim.road.oneWay ? 1 : 0,
    has_median: sim.road.hasMedian ? 1 : 0,
    has_shoulder: sim.road.shoulder ? 1 : 0,
    junction_dist: junctionDist,
    free_left: vehicle.crossTraffic || vehicle.oncoming ? 0 : freeSpace(sim, vehicle.lane - 1, vehicle.x, vehicle.id),
    free_right: vehicle.crossTraffic || vehicle.oncoming ? 0 : freeSpace(sim, vehicle.lane + 1, vehicle.x, vehicle.id),
    veh_speed: vehicle.speed,
    amb_speed: sim.ambulance.speed,
    density: localDensity(sim, vehicle.x),
    oncoming: vehicle.oncoming ? 1 : 0,
  };
}

export function corridorFeatures(sim, ambSpeed = sim.ambulance.speed) {
  return {
    amb_speed: ambSpeed,
    density: localDensity(sim, sim.ambulance.x),
    road_type_code: ROAD_TYPE_CODES[sim.road.id],
    n_lanes: sim.road.lanes,
    slower_ahead_150m: slowerVehiclesAhead(sim),
  };
}

export function etaFeatures(sim, remainingDist) {
  return {
    remaining_dist: remainingDist,
    amb_speed: sim.ambulance.speed,
    density: localDensity(sim, sim.ambulance.x),
    road_type_code: ROAD_TYPE_CODES[sim.road.id],
    slower_ahead_150m: slowerVehiclesAhead(sim),
  };
}
