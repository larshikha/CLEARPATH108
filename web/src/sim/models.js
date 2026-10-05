import moveSideJson from '../../public/models/move_side.json' with { type: 'json' };
import corridorJson from '../../public/models/corridor.json' with { type: 'json' };
import etaJson from '../../public/models/eta.json' with { type: 'json' };
import { loadForest } from './forest.js';

// Models are bundled locally: inference needs no ML server or network connection.
export const forests = Object.freeze({
  moveSide: loadForest(moveSideJson),
  corridor: loadForest(corridorJson),
  eta: loadForest(etaJson),
});
