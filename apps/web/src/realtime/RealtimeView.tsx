import { useCallback, useMemo, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { fmtClock } from './format';
import { IncidentCard } from './IncidentCard';
import { IncidentList } from './IncidentList';
import { visibleIncidents } from './layers';
import { Legend } from './Legend';
import { SourceBadge, StatusChip } from './StatusChip';
import type { StreamId } from './types';
import { useIncidentDetail } from './useIncidentDetail';
import { useRealtimeLayers } from './useRealtimeLayers';
import { useRealtimeStream } from './useRealtimeStream';
import './realtime.css';

const NO_ANNOTATIONS: never[] = [];

/** Map padding so a fitted incident is not hidden under the side panel. */
function panelPadding(): mapboxgl.PaddingOptions {
  const narrow = window.innerWidth < 700;
  return narrow
    ? { top: 80, bottom: Math.round(window.innerHeight * 0.45), left: 30, right: 30 }
    : { top: 90, bottom: 110, left: 380, right: 80 };
}

interface Props {
  map: mapboxgl.Map;
}

export function RealtimeView({ map }: Props) {
  const stream: StreamId = 'live';
  const isReplay = false;
  const rt = useRealtimeStream(stream, map);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
      if (!inc) return;
      const [w, s, e, n] = inc.bbox;
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: panelPadding(), maxZoom: 9.5, duration: 1600, essential: true },
      );
    },
    [map, rt.incidents],
  );

  useRealtimeLayers(map, {
    points: rt.points,
    clock: rt.clock,
    incidents: ranked,
    selectedId,
    annotations: NO_ANNOTATIONS,
    onSelect: select,
  });

  return (
    <>
      <aside className="rt-panel material" aria-label="Realtime fire incidents">
        <div className="rt-panel__head">
          <div className="rt-panel__title">
            <h2>Fire incidents</h2>
            <SourceBadge replay={isReplay} />
          </div>
          <StatusChip status={rt.connection} />
        </div>
        {rt.clock !== null && (
          <p className="rt-panel__asof">Latest detection {fmtClock(rt.clock)}</p>
        )}

        <div className="rt-panel__body">
          {selected ? (
            <IncidentCard
              incident={selected}
              detail={detail}
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
                rt.connection === 'live'
                  ? 'No significant incidents in the live stream yet.'
                  : 'Waiting for the realtime service…'
              }
            />
          )}
        </div>
      </aside>
      <Legend />
    </>
  );
}
