import React, { useEffect, useRef, useState } from 'react';
import { createSim, getState, isFinished, step, WORLD_LENGTH } from './sim/engine.js';
import { rankHospitals } from './sim/hospitals.js';
import RoadCanvas from './components/RoadCanvas.jsx';
import ResultsTable from './components/ResultsTable.jsx';

const roadLabels = { multilane: 'Multi-lane', divided: 'Divided', junction: 'Junction' };
const densityLabels = { low: 'Low', med: 'Medium', high: 'High' };
const normalizeRoadType = roadType => Object.hasOwn(roadLabels, roadType) ? roadType : 'multilane';

export default function App() {
  const [roadType, setRoadType] = useState('multilane');
  const [density, setDensity] = useState('high');
  const [seed, setSeed] = useState(108);
  const simRef = useRef(null);
  const timerRef = useRef(null);
  const [state, setState] = useState(() => getState(createSim({ roadType: 'multilane', density: 'high', seed: 108, mode: 'clearpath' })));
  const [benchmark, setBenchmark] = useState(null);
  const [emergencyType, setEmergencyType] = useState('Cardiac');
  const [running, setRunning] = useState(false);
  const [activeMode, setActiveMode] = useState(null);
  const [completedRuns, setCompletedRuns] = useState({ baseline: null, clearpath: null });

  function stopTimer() {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setRunning(false);
  }

  function startRun(mode, nextRoad = roadType, nextDensity = density, nextSeed = seed) {
    stopTimer();
    setActiveMode(mode);
    const sim = createSim({ roadType: normalizeRoadType(nextRoad), density: nextDensity, seed: nextSeed, mode });
    simRef.current = sim;
    setState(getState(sim));
    setRunning(true);
    timerRef.current = window.setInterval(() => {
      const live = simRef.current;
      if (!live || isFinished(live)) {
        stopTimer();
        return;
      }
      step(live);
      const snapshot = getState(live);
      setState(snapshot);
      if (snapshot.finished) {
        setCompletedRuns(previous => ({ ...previous, [mode]: snapshot.metrics }));
        setActiveMode(null);
        stopTimer();
      }
    }, 100);
  }

  useEffect(() => {
    startRun('clearpath');
    fetch('/results/benchmark.json').then(response => response.ok ? response.json() : null).then(setBenchmark).catch(() => {});
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  function updateScenario(change) {
    const next = { roadType, density, seed, ...change, roadType: normalizeRoadType(change.roadType ?? roadType) };
    setRoadType(next.roadType);
    setDensity(next.density);
    setSeed(next.seed);
    setCompletedRuns({ baseline: null, clearpath: null });
    startRun('clearpath', next.roadType, next.density, next.seed);
  }

  function moveEntity(id, x, lane) {
    const sim = simRef.current;
    if (!sim) return;
    if (id === 'ambulance') {
      sim.ambulance.x = Math.max(0, Math.min(WORLD_LENGTH, x));
      if (lane >= 0 && lane < sim.road.lanes) sim.ambulance.lane = lane;
    } else {
      const vehicle = sim.vehicles.find(item => item.id === id);
      if (!vehicle) return;
      vehicle.x = Math.max(-30, Math.min(WORLD_LENGTH + 30, x));
      if (lane >= 0 && lane < sim.road.lanes) vehicle.lane = lane;
    }
    setState(getState(sim));
  }

  const hospitalRecommendations = simRef.current ? rankHospitals(simRef.current, emergencyType) : [];
  const recommendedHospital = hospitalRecommendations[0] ?? null;
  const ambulanceStatus = state.finished ? 'Arrived' : state.ambulance.speed < 16.2 ? 'Delayed' : 'En route';

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-mark">108</div>
      <div><div className="eyebrow">SIMULATION CONTROL</div><h1>CLEARPATH <span>108</span></h1></div>
      <div className="simulation-badge"><i /> SIMULATED GPS</div>
    </header>

    <div className="workspace">
    <section className="main-column">
      <div className="section-heading">
        <div><div className="eyebrow">ROAD SCENARIO</div><h2>Emergency road</h2></div>
        <div className={`run-status ${running ? 'is-running' : ''}`}><i />{running ? 'Simulation running' : state.finished ? 'Run complete' : 'Ready'}</div>
      </div>
      <p className="subheading">{roadLabels[roadType]} road <span>·</span> {densityLabels[density]} traffic <span>·</span> Corridor {state.corridorLen} m <small>Hybrid: placeholder moves + ML corridor/ETA | ETA to hospital {recommendedHospital ? `${recommendedHospital.eta.toFixed(1)} s` : 'calculating'}</small></p>
      <RoadCanvas state={state} onMoveEntity={moveEntity} />
      <section className="scenario-panel panel">
        <div className="scenario-topline"><div><div className="eyebrow">SCENARIO SETUP</div><h2>Road and traffic</h2></div><label className="seed-field">Seed <input type="number" min="0" value={seed} onChange={event => updateScenario({ seed: Math.max(0, Number(event.target.value) || 0) })} /></label></div>
        <div className="choice-row"><span className="choice-label">ROAD TYPE</span>{Object.entries(roadLabels).map(([key, label]) => <button key={key} className={`chip ${roadType === key ? 'selected' : ''}`} onClick={() => updateScenario({ roadType: key })}>{label}</button>)}</div>
        <div className="choice-row"><span className="choice-label">TRAFFIC</span>{Object.entries(densityLabels).map(([key, label]) => <button key={key} className={`chip ${density === key ? 'selected' : ''}`} onClick={() => updateScenario({ density: key })}>{label}</button>)}</div>
        <div className="scenario-footer"><span>{state.vehicles.filter(vehicle => !vehicle.oncoming && !vehicle.crossTraffic).length} vehicles <span className="dot-separator">·</span> seed {seed}</span></div>
      </section>
      <ResultsTable roadType={roadType} density={density} seed={seed} onRun={mode => startRun(mode)} activeMode={activeMode} state={state} completedRuns={completedRuns} benchmark={benchmark} />
    </section>
    <aside className="side-column">
      <section className="panel status-panel">
        <div className="eyebrow">SYSTEM STATUS</div><h2>Connected simulation</h2>
        <div className="status-row"><span><i className="status-dot green" />Data</span><strong>SIMULATED GPS</strong></div>
        <div className="status-row"><span><i className="status-dot green" />Corridor length</span><strong>{state.corridorLen} m</strong></div>
        <div className="status-row"><span><i className="status-dot green" />V2V</span><strong>Simulated</strong></div>
        <div className="status-row"><span><i className="status-dot green" />AI decision</span><strong>ACTIVE</strong></div>
      </section>
      <section className="panel ambulance-panel">
        <div className="eyebrow">AMBULANCE</div>
        <div className="ambulance-heading"><div className="ambulance-icon">🚑</div><div><h2>Unit 108</h2><span className="muted">Number 123</span></div></div>
        <div className="ambulance-metric"><span>ETA to hospital</span><strong>{recommendedHospital ? `${recommendedHospital.eta.toFixed(1)} s` : '—'}</strong></div>
        <div className="ambulance-metric"><span>Status</span><strong className={ambulanceStatus === 'Delayed' ? 'status-delayed' : 'status-ok'}>{ambulanceStatus}</strong></div>
      </section>
      <section className="panel hospital-panel">
        <div className="eyebrow">HOSPITAL SELECTION</div><h2>Recommended hospitals</h2>
        <p className="hospital-method">Weighted multi-criteria score · rule-based</p>
        <div className="emergency-chips" role="group" aria-label="Emergency type">
          {['Cardiac', 'Trauma', 'Stroke'].map(type => <button key={type} className={`chip ${emergencyType === type ? 'selected' : ''}`} onClick={() => setEmergencyType(type)}>{type}</button>)}
        </div>
        <div className="hospital-list">{hospitalRecommendations.map(hospital => <article key={hospital.id} className={`hospital-row ${hospital.rank === 1 ? 'recommended' : ''}`}>
          <div className="hospital-row-title"><strong>{hospital.rank}. {hospital.name}</strong><span>{hospital.score.toFixed(2)}</span></div>
          <div className="hospital-details"><span>ETA {hospital.eta.toFixed(1)} s</span><span>ICU free {hospital.icu_free}</span></div>
          <div className="hospital-details"><span>{hospital.distance_m} m away</span><span className={hospital.suitability ? 'status-ok' : 'muted'}>{hospital.suitabilityText}</span></div>
        </article>)}</div>
        <p className="hospital-footer">Score = ETA, availability, suitability. Hospital capacity and distances are simulated.</p>
      </section>
    </aside>
    </div>
    <footer className="footer-note"><span>↔</span> Drag the ambulance or a vehicle to reposition it. All positions and traffic are simulated.</footer>
  </main>;
}
