import { useCallback, useEffect, useMemo, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { Segmented } from '../components/Segmented';
import { fmtClock } from './format';
import { IncidentCard } from './IncidentCard';
import { IncidentList, fmtLatLon } from './IncidentList';
import { visibleIncidents, type Annotation } from './layers';
import { Legend } from './Legend';
import { ReplayHud } from './ReplayHud';
import { SCENARIOS, SPEEDS, scenarioById, type Scenario, type SpeedId } from './scenarios';
import { SourceBadge, StatusChip } from './StatusChip';
import type { Bbox, StreamId } from './types';
import { useIncidentDetail } from './useIncidentDetail';
import { useRealtimeLayers } from './useRealtimeLayers';
import { useReplay } from './useReplay';
import { useRealtimeStream } from './useRealtimeStream';
import './realtime.css';

const NO_ANNOTATIONS: Annotation[] = [];
const MODES = [
  { id: 'live' as const, label: 'Live' },
  { id: 'replay' as const, label: 'Replay' },
];

/** What the chat copilot needs to know about the realtime tab. */
export interface RealtimeContext {
  stream: StreamId | null;
  /** Selected incident or scenario, for the AOI label. */
  label: string | null;
  /** Scenario data window, when replaying one. */
  range: { from: string; to: string } | null;
}

/** Map padding so a fitted area is not hidden under the panel and HUD. */
function panelPadding(): mapboxgl.PaddingOptions {
  const narrow = window.innerWidth < 700;
  return narrow
    ? { top: 150, bottom: Math.round(window.innerHeight * 0.45), left: 30, right: 30 }
    : { top: 150, bottom: 110, left: 380, right: 80 };
}

function fit(map: mapboxgl.Map, [w, s, e, n]: Bbox, maxZoom: number, duration: number) {
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: panelPadding(), maxZoom, duration, essential: true },
  );
}

interface Props {
  map: mapboxgl.Map;
  onContextChange?(ctx: RealtimeContext): void;
}

export function RealtimeView({ map, onContextChange }: Props) {
  const replay = useReplay();
  const [speed, setSpeed] = useState<SpeedId>('12000');
  const isReplay = replay.mode === 'replay';
  const stream: StreamId | null = isReplay ? (replay.info?.stream ?? null) : 'live';
  const scenario = isReplay ? scenarioById(replay.info?.scenario) : null;

  const rt = useRealtimeStream(stream, map);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => setSelectedId(null), [stream]);

  const ranked = useMemo(() => visibleIncidents(rt.incidents.values()), [rt.incidents]);
  const selected = selectedId ? (rt.incidents.get(selectedId) ?? null) : null;
  const brief = selectedId ? (rt.briefs.get(selectedId) ?? null) : null;
  const { detail, error } = useIncidentDetail(
    selectedId,
    `${selected?.asOf ?? ''}|${brief?.generatedAt ?? ''}`,
  );

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      const inc = id ? rt.incidents.get(id) : null;
      if (inc) fit(map, inc.bbox, 8, 1600);
    },
    [map, rt.incidents],
  );

  useRealtimeLayers(map, {
    points: rt.points,
    clock: rt.clock,
    incidents: ranked,
    selectedId,
    annotations: scenario?.annotations ?? NO_ANNOTATIONS,
    onSelect: select,
  });

  const startScenario = (s: Scenario) => {
    fit(map, s.bounds, 7, 2400);
    void replay.start(s.id, Number(speed));
  };

  const nearestName = detail?.summary.id === selectedId && detail?.enrichment?.places?.status === 'ok'
    ? detail.enrichment.places.data[0]?.name
    : undefined;
  const contextLabel = selected
    ? `${nearestName ? `Fire near ${nearestName}` : `Fire at ${fmtLatLon(selected.centroid)}`} (${selected.id})`
    : (scenario?.title ?? null);
  useEffect(() => {
    onContextChange?.({
      stream,
      label: contextLabel,
      range: scenario ? { from: scenario.from, to: scenario.to } : null,
    });
  }, [onContextChange, stream, contextLabel, scenario]);

  const replayStatus = rt.replay?.status ?? replay.info?.status ?? 'running';
  const replayProgress = rt.replay?.progress ?? replay.info?.progress ?? 0;
  const speedLabel =
    SPEEDS.find((s) => Number(s.id) === replay.info?.speed)?.label ??
    `${Math.round((replay.info?.speed ?? 12000) / 3600)} h/s`;
  const showHud = isReplay && replay.info;
  const showPicker =
    isReplay && (!replay.info || ['stopped', 'done', 'error'].includes(replayStatus));

  return (
    <>
      {showHud && replay.info && (
        <ReplayHud
          title={scenario?.title ?? replay.info.scenario}
          clock={rt.clock ?? replay.info.streamT ?? replay.info.startT}
          status={replayStatus}
          progress={replayProgress}
          speedLabel={speedLabel}
          busy={replay.busy}
          note={replay.info.origin === 'bundled' ? replay.info.note : null}
          onPause={() => void replay.control('pause')}
          onResume={() => void replay.control('resume')}
          onStop={() => void replay.control('stop')}
          onRestart={() => {
            const s = scenarioById(replay.info?.scenario) ?? SCENARIOS[0];
            startScenario(s);
          }}
        />
      )}

      <aside className="rt-panel material" aria-label="Realtime fire incidents">
        <div className="rt-panel__head">
          <div className="rt-panel__title">
            <h2>Fire incidents</h2>
            <SourceBadge replay={isReplay} />
          </div>
          {stream && <StatusChip status={rt.connection} />}
        </div>

        <div className="rt-panel__mode">
          <Segmented
            options={MODES}
            value={replay.mode}
            onChange={replay.setMode}
            label="Stream"
            className="segmented--fill"
          />
        </div>

        {!isReplay && rt.clock !== null && (
          <p className="rt-panel__asof">Latest detection {fmtClock(rt.clock)}</p>
        )}

        {showPicker && (
          <div className="rt-panel__section rt-scenarios">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="rt-scenario"
                disabled={replay.busy}
                onClick={() => startScenario(s)}
              >
                <span className="rt-scenario__title">{s.title}</span>
                <span className="rt-scenario__blurb">{s.blurb}</span>
              </button>
            ))}
            <div className="rt-speed">
              <span className="rt-dim">Speed</span>
              <Segmented
                options={SPEEDS}
                value={speed}
                onChange={(v: SpeedId) => setSpeed(v)}
                label="Replay speed"
                className="segmented--fill"
                disabled={replay.busy}
              />
            </div>
          </div>
        )}
        {replay.error && isReplay && <p className="rt-error">{replay.error}</p>}

        {stream && (
          <div className="rt-panel__body">
            {selected ? (
              <IncidentCard
                incident={selected}
                detail={detail?.summary.id === selected.id ? detail : null}
                detailError={error}
                brief={brief}
                clock={rt.clock}
                replay={isReplay}
                onBack={() => setSelectedId(null)}
              />
            ) : (
              <IncidentList
                incidents={ranked}
                selectedId={selectedId}
                clock={rt.clock}
                onSelect={select}
                emptyText={
                  rt.connection !== 'live'
                    ? 'Waiting for the realtime service…'
                    : isReplay
                      ? 'Incidents appear here as the replay forms them.'
                      : 'No significant incidents in the live stream yet.'
                }
              />
            )}
          </div>
        )}
      </aside>
      <Legend />
    </>
  );
}
