// Lane 0 is the top lane and the driver's LEFT; the highest index is the
// driver's RIGHT. Therefore MOVE LEFT always means a lower lane index.
const definitions = {
  multilane: { id: 'multilane', lanes: 3, laneWidth: 3.5, hasMedian: false, oneWay: true, junctionX: null, shoulder: false, oncomingLanes: 0 },
  divided: { id: 'divided', lanes: 2, laneWidth: 3.5, hasMedian: true, oneWay: false, junctionX: null, shoulder: false, oncomingLanes: 2 },
  junction: { id: 'junction', lanes: 3, laneWidth: 3.5, hasMedian: false, oneWay: true, junctionX: 600, shoulder: false, oncomingLanes: 0 },
};

export const ROAD_TYPES = Object.freeze(Object.keys(definitions));

export function getRoad(id = 'multilane') {
  const road = definitions[id];
  if (!road) throw new RangeError(`Unknown road type: ${id}`);
  return { ...road };
}

export function getRoadTypes() {
  return ROAD_TYPES.map(getRoad);
}
