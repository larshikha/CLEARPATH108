import { etaFeatures } from './features.js';
import { forests } from './models.js';

// Demonstration data only; these hospitals, capacities and distances are simulated.
export const HOSPITALS = Object.freeze([
  { id: 'north-community', name: 'North Community Hospital', distance_m: 350, icu_free: 1, specialties: ['Stroke'] },
  { id: 'regional-heart', name: 'Regional Heart Centre', distance_m: 880, icu_free: 3, specialties: ['Cardiac'] },
  { id: 'central-trauma', name: 'Central Trauma Hospital', distance_m: 600, icu_free: 2, specialties: ['Trauma', 'Stroke'] },
]);

const EMERGENCY_TYPES = new Set(['Cardiac', 'Trauma', 'Stroke']);

function hospitalEta(sim, distance) {
  if (sim.finished) return 0;
  return Math.max(0, forests.eta.predict(etaFeatures(sim, distance)));
}

export function rankHospitals(sim, emergencyType = 'Cardiac') {
  if (!EMERGENCY_TYPES.has(emergencyType)) throw new RangeError(`Unknown emergency type: ${emergencyType}`);
  const hospitals = HOSPITALS.map(hospital => ({
    ...hospital,
    eta: hospitalEta(sim, hospital.distance_m),
    diverted: hospital.diverted === true,
    suitability: hospital.specialties.includes(emergencyType),
  }));
  const minEta = Math.min(...hospitals.map(hospital => hospital.eta));
  const maxEta = Math.max(...hospitals.map(hospital => hospital.eta));
  return hospitals.map(hospital => {
    const etaScore = maxEta === minEta ? 1 : 1 - (hospital.eta - minEta) / (maxEta - minEta);
    const availability = hospital.icu_free === 0 || hospital.diverted ? 0 : Math.min(1, hospital.icu_free / 3);
    const suitability = hospital.suitability ? 1 : 0;
    return {
      ...hospital,
      score: 0.4 * etaScore + 0.3 * availability + 0.3 * suitability,
      suitabilityText: hospital.suitability ? `Suitable for ${emergencyType}` : `No ${emergencyType} specialty`,
    };
  }).sort((a, b) => b.score - a.score || a.eta - b.eta || a.id.localeCompare(b.id))
    .map((hospital, index) => ({ ...hospital, rank: index + 1 }));
}
