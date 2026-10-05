import React from 'react';

const roadLabels = { multilane: 'Multi-lane', divided: 'Divided', junction: 'Junction' };
const densityLabels = { low: 'Low', med: 'Medium', high: 'High' };
const seconds = value => Number.isFinite(value) ? `${value.toFixed(1)} s` : '—';
const percent = value => Number.isFinite(value) ? `${value.toFixed(2)}%` : 'not available';
const percentage = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const improvement = (baseline, clearpath) => Number.isFinite(baseline) && baseline > 0 && Number.isFinite(clearpath)
  ? percentage.format((baseline - clearpath) / baseline) : '—';

export default function ResultsTable({ roadType, density, seed, onRun, activeMode, state, completedRuns, benchmark }) {
  const selectedRoadType = Object.hasOwn(roadLabels, roadType) ? roadType : 'multilane';
  const baseline = activeMode === 'baseline' ? state.metrics : completedRuns.baseline;
  const clearpath = activeMode === 'clearpath' ? state.metrics : completedRuns.clearpath;
  const bothComplete = activeMode === null && completedRuns.baseline && completedRuns.clearpath;
  const scenario = benchmark?.scenarios?.find(item => item.roadType === selectedRoadType && item.density === density);
  const travelImprovement = scenario?.comparison.travelImprovementPct.mean;
  const clearanceImprovement = scenario?.comparison.clearanceImprovementPct.mean;
  const clearanceCountNote = scenario && scenario.comparison.clearanceImprovementSampleCount !== scenario.seedCount
    ? ` (${scenario.comparison.clearanceImprovementSampleCount} baseline-positive runs for clearance)` : '';

  return <section className="scenario-panel panel results-card">
    <div className="results-title"><div><div className="eyebrow">SCENARIO RESULTS</div><h3>Same scenario comparison</h3></div><span className="table-note">Seed {seed}</span></div>
    <div className="run-buttons results-run-buttons">
      <button className="button secondary" onClick={() => onRun('baseline')}>Run baseline</button>
      <button className="button primary" onClick={() => onRun('clearpath')}>Run CLEARPATH</button>
    </div>
    <div className="benchmark-scroll"><table><thead><tr><th>Metric</th><th>Baseline</th><th>CLEARPATH</th><th>Improvement</th></tr></thead><tbody>
      <tr><td>Travel time</td><td>{seconds(baseline?.travelTime)}</td><td>{seconds(clearpath?.travelTime)}</td><td>{bothComplete ? improvement(completedRuns.baseline.travelTime, completedRuns.clearpath.travelTime) : '—'}</td></tr>
      <tr><td>Corridor clearance</td><td>{seconds(baseline?.clearanceTime)}</td><td>{seconds(clearpath?.clearanceTime)}</td><td>{bothComplete ? improvement(completedRuns.baseline.clearanceTime, completedRuns.clearpath.clearanceTime) : '—'}</td></tr>
      <tr><td>Blocked time</td><td>{seconds(baseline?.blockedTime)}</td><td>{seconds(clearpath?.blockedTime)}</td><td>—</td></tr>
      <tr><td>Alerts / collisions</td><td>{baseline ? `${baseline.alertsSent} / ${baseline.collisions}` : '—'}</td><td>{clearpath ? `${clearpath.alertsSent} / ${clearpath.collisions}` : '—'}</td><td>—</td></tr>
    </tbody></table></div>
    {!bothComplete && <p className="comparison-prompt">Run both to compare</p>}
    <div className="results-benchmark-line">
      {scenario
        ? `Benchmark (${scenario.seedCount} seeds): mean improvement ${percent(travelImprovement)} travel, ${percent(clearanceImprovement)} clearance${clearanceCountNote}${scenario.polished ? '' : ' · Unpolished road scenario'}`
        : `Benchmark unavailable for ${roadLabels[selectedRoadType]} / ${densityLabels[density]}.`}
    </div>
  </section>;
}
