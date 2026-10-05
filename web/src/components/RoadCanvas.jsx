import React, { useRef } from 'react';

const WORLD_LENGTH = 1200;
const laneHeight = 62;
const topPad = 34;
const bottomPad = 42;

export default function RoadCanvas({ state, onMoveEntity }) {
  const svgRef = useRef(null);
  const lanes = state.road.lanes;
  const oncoming = state.road.oncomingLanes;
  const roadLaneCount = lanes + oncoming;
  const roadTop = topPad;
  const roadHeight = roadLaneCount * laneHeight + (state.road.hasMedian ? 20 : 0);
  const height = topPad + roadHeight + bottomPad;
  const medianOffset = state.road.hasMedian ? 20 : 0;
  const ambulanceLaneY = lane => roadTop + lane * laneHeight + laneHeight / 2 + (state.road.hasMedian && lane >= lanes ? medianOffset : 0);
  const roadX = event => {
    const rect = svgRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(WORLD_LENGTH, ((event.clientX - rect.left) / rect.width) * WORLD_LENGTH));
  };
  const laneFromY = event => {
    const rect = svgRef.current.getBoundingClientRect();
    const y = ((event.clientY - rect.top) / rect.height) * height - roadTop;
    if (state.road.hasMedian && y >= lanes * laneHeight + medianOffset) {
      return lanes + Math.floor((y - lanes * laneHeight - medianOffset) / laneHeight);
    }
    return Math.max(0, Math.min(lanes - 1, Math.floor(y / laneHeight)));
  };
  function onPointerDown(event, id) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = pointerEvent => {
      const x = roadX(pointerEvent);
      let lane = laneFromY(pointerEvent);
      if (id.startsWith('o')) lane = lanes + Math.max(0, Math.min(oncoming - 1, lane));
      onMoveEntity(id, x, lane);
    };
    move(event);
    const finish = pointerEvent => {
      event.currentTarget.removeEventListener('pointermove', move);
      event.currentTarget.removeEventListener('pointerup', finish);
      event.currentTarget.removeEventListener('pointercancel', finish);
    };
    event.currentTarget.addEventListener('pointermove', move);
    event.currentTarget.addEventListener('pointerup', finish);
    event.currentTarget.addEventListener('pointercancel', finish);
  }

  return <div className="road-frame panel">
    <div className="road-caption"><div><span className="live-pulse" /> ROAD SIMULATION</div><span className="time-readout">T+ {state.time.toFixed(1)} s</span></div>
    <svg ref={svgRef} className="road-svg" viewBox={`0 0 1200 ${height}`} role="img" aria-label={`${state.road.id} simulated road with ambulance and traffic`}>
      <defs>
        <pattern id="asphalt" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#182235" /><circle cx="3" cy="6" r="0.6" fill="#ffffff" opacity="0.025" /><circle cx="12" cy="13" r="0.6" fill="#ffffff" opacity="0.025" /></pattern>
        <pattern id="corridor-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" fill="#ef4444" opacity="0.08" /><line x1="0" y1="0" x2="0" y2="10" stroke="#fb7185" strokeWidth="2" opacity="0.23" /></pattern>
      </defs>
      <rect x="0" y="0" width="1200" height={height} fill="#0d1625" />
      <text x="0" y="21" className="svg-endpoint">START</text><text x="1200" y="21" textAnchor="end" className="svg-endpoint">DESTINATION · 1,200 M</text>
      <rect x="0" y={roadTop} width="1200" height={roadHeight} rx="8" fill="url(#asphalt)" stroke="#29364b" />
      {Array.from({ length: roadLaneCount - 1 }, (_, index) => {
        const y = roadTop + (index + 1) * laneHeight + (state.road.hasMedian && index >= lanes - 1 ? medianOffset : 0);
        return <line key={index} x1="10" x2="1190" y1={y} y2={y} className={state.road.hasMedian && index === lanes - 1 ? 'median-line' : 'lane-line'} />;
      })}
      {state.road.hasMedian && <rect x="8" y={roadTop + lanes * laneHeight - 8} width="1184" height="20" fill="#243043" stroke="#37455b" />}
      {state.road.junctionX && <g><rect x={state.road.junctionX - 50} y={roadTop - 26} width="100" height={roadHeight + 52} rx="4" className="junction-marking" /><line x1={state.road.junctionX} x2={state.road.junctionX} y1={roadTop} y2={roadTop + roadHeight} className="junction-center" /><text x={state.road.junctionX} y={roadTop - 9} textAnchor="middle" className="svg-label">CROSS ROAD</text></g>}
      {!state.finished && <g><rect x={state.ambulance.x} y={roadTop} width={Math.max(0, Math.min(state.corridorLen, 1200 - state.ambulance.x))} height={lanes * laneHeight} fill="url(#corridor-hatch)" stroke="#fb7185" strokeDasharray="8 7" /><text x={Math.min(1190, state.ambulance.x + 10)} y={roadTop + 17} className="corridor-label">EMERGENCY CORRIDOR · {state.corridorLen} M</text></g>}
      {state.vehicles.filter(v => v.crossTraffic).map(vehicle => <g key={vehicle.id} transform={`translate(${vehicle.x},${roadTop + laneHeight / 2})`}><rect x="-16" y="-11" width="32" height="22" rx="5" className="cross-car" /><text textAnchor="middle" y="4" className="vehicle-glyph">🚗</text></g>)}
      {state.vehicles.filter(v => !v.crossTraffic).map(vehicle => <g key={vehicle.id} className="draggable" onPointerDown={event => onPointerDown(event, vehicle.id)} transform={`translate(${vehicle.x},${ambulanceLaneY(vehicle.lane)})`}>
        <circle r="16" className={`vehicle-halo ${(vehicle.state === 'alerted' || vehicle.holdingForPolicy) ? 'alerted' : ''}`} /><text textAnchor="middle" y="6" className="vehicle-glyph">{vehicle.oncoming ? '🚙' : '🚗'}</text>{(vehicle.state === 'alerted' || vehicle.holdingForPolicy) && <g><text x="0" y="-23" textAnchor="middle" className="vehicle-action">{vehicle.action === 'LEFT' ? '← LEFT' : vehicle.action === 'RIGHT' ? 'RIGHT →' : vehicle.action}{Number.isFinite(vehicle.confidence) ? ` | ${Math.round(vehicle.confidence * 100)}%` : ''}</text><text x="0" y="-35" textAnchor="middle" className="vehicle-explanation">{vehicle.explanation}</text></g>}
      </g>)}
      <g className="draggable ambulance-marker" onPointerDown={event => onPointerDown(event, 'ambulance')} transform={`translate(${state.ambulance.x},${ambulanceLaneY(state.ambulance.lane)})`}><circle r="20" className="ambulance-halo" /><text textAnchor="middle" y="7" className="ambulance-glyph">🚑</text></g>
      <line x1="0" x2="100" y1={height - 18} y2={height - 18} className="scale-line" /><line x1="0" x2="0" y1={height - 23} y2={height - 13} className="scale-cap" /><line x1="100" x2="100" y1={height - 23} y2={height - 13} className="scale-cap" /><text x="110" y={height - 14} className="scale-label">100 px = 100 m</text>
    </svg>
    <div className="road-legend"><span><i className="legend-ambulance" /> Ambulance</span><span><i className="legend-car" /> Traffic</span><span><i className="legend-corridor" /> Emergency corridor</span><span className="legend-hint">↔ Drag to reposition</span></div>
  </div>;
}
