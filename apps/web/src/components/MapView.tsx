import { useEffect, useRef, useState } from 'react';
import { Ember } from './Ember';
import mapboxgl from 'mapbox-gl';
import { applyBasemap, BASEMAPS } from '../lib/basemaps';
import { resolveLightPreset, type MapSettings } from '../lib/mapSettings';
import { applyOverlays } from '../lib/overlays';
import { BasemapSwitcher } from './BasemapSwitcher';
import { useColorScheme, type ColorScheme } from '../lib/useColorScheme';
import { useGlobeSpin } from '../lib/useGlobeSpin';
import { LayersPanel } from './LayersPanel';
import { MapControls } from './MapControls';
import { StatusBar } from './StatusBar';
import { CalendarDrawer } from './CalendarDrawer';
import { useArchivalLayers } from '../lib/useArchivalLayers';
import { FIRE, FIRE_POINTS, flameRamp, PRONE, drawRegions } from '../lib/fireLayers';
import { useMeasure, fmtArea, fmtKm } from '../lib/measure';
import { captureMap } from '../lib/capture';
import { FireExplorer } from './FireExplorer';
import { Toolbar } from './Toolbar';
import { DETAIL_MISSING_TEXT, getMeta } from '../lib/api';
import { showcaseFor, useArchiveInfo } from '../lib/useArchiveDetail';
import { closeWhenOtherOpens, panelOpened } from '../lib/panels';
import type { Tab } from '../lib/dataWindows';

// Shifted west so the incident panel covers the open Pacific, not North America.
const INITIAL_CENTER: [number, number] = [-52, 28];
const TERMINATOR_REFRESH_MS = 60_000;

/** Flat Mercator world filling the screen: one world width (512 px at z0) covers the larger side. */
function initialZoom(): number {
  return Math.max(0, Math.log2(Math.max(window.innerWidth, window.innerHeight) / 512));
}

function applyAll(map: mapboxgl.Map, settings: MapSettings, scheme: ColorScheme) {
  const preset = resolveLightPreset(settings.light, scheme);
  applyBasemap(map, settings, preset);
  applyOverlays(map, settings, preset);
}

/** Config calls throw while a new style is still loading; `style.load` re-applies. */
function tryApplyAll(map: mapboxgl.Map, settings: MapSettings, scheme: ColorScheme) {
  try {
    applyAll(map, settings, scheme);
  } catch {
    /* applied on the next `style.load` */
  }
}

interface Props {
  tab: Tab;
  from: string;
  to: string;
  rangeLabel: string;
  onPickDate(date: string): void;
  settings: MapSettings;
  update(patch: Partial<MapSettings>): void;
  reset(): void;
  initialView?: { center: [number, number]; zoom: number } | null;
  shareUrl(view: { center: [number, number]; zoom: number }): string;
  /** Called with the map once it exists, and with null when it is removed. */
  onMapReady?(map: mapboxgl.Map | null): void;
  /** Bumped to open the calendar on request (welcome card, copilot), even if it was closed earlier. */
  calendarRequest?: number;
}

const CALENDAR_CLOSED_KEY = 'fires.calendarClosed';
/** The user closed the calendar drawer this session: it is not opened automatically again. */
const calendarClosedByUser = () => {
  try { return sessionStorage.getItem(CALENDAR_CLOSED_KEY) === '1'; } catch { return false; }
};
const rememberCalendarClosed = () => {
  try { sessionStorage.setItem(CALENDAR_CLOSED_KEY, '1'); } catch { /* private mode: closes for this page view only */ }
};

export function MapView({ tab, from, to, rangeLabel, onPickDate, settings, update, reset, initialView, shareUrl, onMapReady, calendarRequest = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<mapboxgl.Map | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(() => window.innerWidth >= 900);
  // Collapsed until asked for: the toolbar toggle, a region click or an analysed area opens it.
  const [timelineOpen, setTimelineOpen] = useState(false);
  // The calendar is the archive's main view: open it when the Archival tab is shown (also on first load via #t=archival)
  // unless the user closed it earlier in this session.
  useEffect(() => {
    if (tab === 'archival' && !calendarClosedByUser()) setTimelineOpen(true);
  }, [tab]);
  useEffect(() => {
    if (calendarRequest > 0) setTimelineOpen(true);
  }, [calendarRequest]);
  const closeTimeline = () => { rememberCalendarClosed(); setTimelineOpen(false); };
  // Narrow screens: the calendar and the copilot take turns (the copilot opening closes the calendar for now,
  // without counting as the user closing it).
  useEffect(() => { if (timelineOpen) panelOpened('calendar'); }, [timelineOpen]);
  useEffect(() => closeWhenOtherOpens('calendar', () => setTimelineOpen(false)), []);
  useEffect(() => { if (explorerOpen) panelOpened('explorer'); }, [explorerOpen]);
  useEffect(() => closeWhenOtherOpens('explorer', () => setExplorerOpen(false)), []);
  const [regionArea, setRegionArea] = useState<{ id: string; bbox: [number, number, number, number]; name: string } | null>(null);
  const { detail, showcase } = useArchiveInfo();
  const scheme = useColorScheme();

  const latest = useRef({ settings, scheme });
  latest.current = { settings, scheme };
  const loadedStyle = useRef(BASEMAPS[settings.basemap].style);

  useEffect(() => {
    const { settings: initial } = latest.current;
    const instance = new mapboxgl.Map({
      container: containerRef.current!,
      style: BASEMAPS[initial.basemap].style,
      projection: initial.projection,
      center: initialView?.center ?? INITIAL_CENTER,
      zoom: initialView?.zoom ?? initialZoom(),
      attributionControl: false,
    });
    instance.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-left');
    instance.on('style.load', () =>
      applyAll(instance, latest.current.settings, latest.current.scheme),
    );
    setMap(instance);
    if (import.meta.env.DEV) (window as unknown as { __map: mapboxgl.Map }).__map = instance; // dev-only debugging handle

    return () => {
      instance.remove();
      setMap(null);
    };
  }, []);

  useEffect(() => {
    if (!map) return;
    const style = BASEMAPS[settings.basemap].style;
    if (style !== loadedStyle.current) {
      loadedStyle.current = style;
      map.setStyle(style);
      return;
    }
    tryApplyAll(map, settings, scheme);
  }, [map, settings, scheme]);

  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;
  useEffect(() => {
    onMapReadyRef.current?.(map);
  }, [map]);

  useEffect(() => {
    map?.setProjection(settings.projection);
  }, [map, settings.projection]);

  useEffect(() => {
    if (!map || !settings.terminator) return;
    const id = setInterval(
      () => tryApplyAll(map, latest.current.settings, latest.current.scheme),
      TERMINATOR_REFRESH_MS,
    );
    return () => clearInterval(id);
  }, [map, settings.terminator]);

  useGlobeSpin(map, settings.spin && settings.projection === 'globe');

  const measure = useMeasure(map);
  const measuring = useRef(false);
  measuring.current = measure.mode !== 'off';
  const [analysed, setAnalysed] = useState<GeoJSON.Polygon | null>(null);
  const measureText = measure.mode === 'distance' ? (measure.points.length >= 2 ? fmtKm(measure.distance) : '')
    : measure.mode === 'area' ? (measure.points.length >= 3 ? `${fmtArea(measure.area)} · perimeter ${fmtKm(measure.distance)}` : '') : '';
  // The API rebuilds a polygon's calendar from an explicit cell list, capped at 25 deg² of bounding box.
  const polyDeg2 = (() => {
    const ring = measure.polygon?.coordinates[0];
    if (!ring) return 0;
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  })();

  // Without the detailed archive the map still draws a showcase period when the range overlaps one.
  const rangeShowcase = tab === 'archival' && detail === false ? showcaseFor(showcase, from, to) : null;
  const layers = useArchivalLayers(map, {
    // The Realtime tab is drawn by RealtimeView (apps/web/src/realtime); these layers are the archive's.
    enabled: tab === 'archival',
    tier: 'archival',
    version: 0,
    detail: detail === false && rangeShowcase ? true : detail,
    from,
    to,
    activity: settings.fireActivity,
    mode: settings.fireMode,
    sensor: settings.showViirs && settings.showModis ? 'all' : settings.showViirs ? 'viirs' : settings.showModis ? 'modis' : 'none',
    coloring: settings.fireColoring,
    prone: settings.proneAreas,
    industrial: settings.industrialHeat,
    // satellite imagery and night/dusk light are dark backgrounds
    dark: settings.basemap === 'satellite' || ['night', 'dusk'].includes(resolveLightPreset(settings.light, scheme)),
  });

  // Harmonized region outlines (from /api/meta), redrawn after style changes.
  const [regions, setRegions] = useState<{ id: string; name: string; bbox: [number, number, number, number] }[] | null>(null);
  useEffect(() => { getMeta().then((m) => setRegions(m.regions)).catch(() => {}); }, []);
  useEffect(() => {
    if (!map) return;
    const draw = () => { try { drawRegions(map, tab === 'archival' && settings.regionOutlines ? regions : null); } catch { /* style loading */ } };
    draw();
    map.on('style.load', draw);
    return () => { map.off('style.load', draw); };
  }, [map, regions, settings.regionOutlines, tab]);

  // Clicking inside a harmonized region opens the calendar for that region (smallest match wins).
  useEffect(() => {
    if (!map || tab !== 'archival' || !regions) return;
    const onClick = (e: mapboxgl.MapMouseEvent) => {
      if (measuring.current) return;
      const { lng, lat } = e.lngLat;
      const hit = regions
        .filter(({ bbox: [w, s, ee, n] }) => lng >= w && lng <= ee && lat >= s && lat <= n)
        .sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))[0];
      if (!hit) return;
      setRegionArea({ id: hit.id, bbox: hit.bbox, name: hit.name });
      setTimelineOpen(true);
    };
    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [map, regions, tab]);

  // Click popups: prone tiles explain WHY; points show the detection.
  useEffect(() => {
    if (!map) return;
    const popup = new mapboxgl.Popup({ closeButton: true, maxWidth: '300px' });
    const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    const onProne = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }) => {
      if (measuring.current) return;
      const p = e.features?.[0]?.properties;
      if (!p) return;
      popup.setLngLat(e.lngLat).setHTML(
        `<b>${esc(String(p.prone_class).replace('_', ' '))} fire-prone area</b><br>${esc(p.why)}<br><span style="opacity:.7">0.25° tile · 2001–2025 · ${Math.round(Number(p.mean_annual_cell_days))} harmonized cell-days/yr${p.peak_month ? ` · peak ${MONTH[Number(p.peak_month) - 1]}` : ''}</span>`,
      ).addTo(map);
    };
    const onPoint = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }) => {
      if (measuring.current) return;
      const p = e.features?.[0]?.properties;
      if (!p) return;
      if (p.harmonized_cell_days != null) {
        popup.setLngLat(e.lngLat).setHTML(`<b>Burning 5.5 km cell</b><br>${esc(Math.round(Number(p.harmonized_cell_days) * 10) / 10)} harmonized cell-days · ${esc(p.active_days)} active day${Number(p.active_days) === 1 ? '' : 's'}<br>last burned ${esc(p.last_seen)}`).addTo(map);
        return;
      }
      popup.setLngLat(e.lngLat).setHTML(`<b>${esc(p.satellite)} ${esc(p.sensor)}</b> · ${esc(p.acq_date)} ${String(p.acq_time).padStart(4, '0')} UTC<br>FRP ${esc(p.frp_mw)} MW · confidence ${esc(p.confidence)}${p.heat_reason ? `<br>industrial heat: ${esc(String(p.heat_reason).replace(/_/g, ' '))}` : ''}`).addTo(map);
    };
    const onCell = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }) => {
      if (measuring.current) return;
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const v = p.harmonized_cell_days ?? p.cell_days;
      popup.setLngLat(e.lngLat).setHTML(`<b>${esc(Math.round(Number(v) * 10) / 10)}</b> ${p.harmonized_cell_days != null ? 'harmonized cell-days (VIIRS-equivalent)' : 'active cell-days'}${p.last_seen ? `<br>last burned ${esc(p.last_seen)}` : ''}${p.source === 'global' ? '<br><span style="opacity:.7">outside harmonized regions: raw sensor activity</span>' : ''}`).addTo(map);
    };
    map.on('click', PRONE, onProne);
    map.on('click', FIRE_POINTS, onPoint);
    map.on('click', FIRE, onCell);
    return () => { map.off('click', PRONE, onProne); map.off('click', FIRE_POINTS, onPoint); map.off('click', FIRE, onCell); popup.remove(); };
  }, [map]);

  return (
    <>
      <div ref={containerRef} className="map" />
      {map && (
        <>
          <MapControls
            map={map}
            layersOpen={layersOpen}
            onLayersOpenChange={setLayersOpen}
            layersPanel={<LayersPanel settings={settings} onChange={update} onReset={reset} />}
          />
          {<BasemapSwitcher value={settings.basemap} onChange={(basemap) => update({ basemap })} />}
          <StatusBar
            map={map}
            showCoordinates={settings.coordinates}
            showScale={settings.scale}
          />
          {rangeShowcase && settings.fireActivity && (
            <div className="map-chip material" role="note">{rangeShowcase.note}</div>
          )}
          {tab === 'archival' && settings.fireActivity && layers.unavailable ? (
            <div className="map-status material" role="status">{DETAIL_MISSING_TEXT}</div>
          ) : tab === 'archival' && (layers.loading || layers.error || layers.truncated) && (
            <div className="map-status material" role="status">
              {layers.error ? `Couldn't load fire data: ${layers.error}` : layers.loading ? <Ember caption="Loading fires" /> : 'Showing the strongest results in view. Zoom in to see all.'}
            </div>
          )}
          {tab === 'archival' && (
            <>
              <FireExplorer
                tier="archival"
                detail={detail !== false || !!rangeShowcase}
                rawPeriod={rangeShowcase ? !rangeShowcase.harmonized : false}
                map={map}
                settings={settings}
                onChange={update}
                rangeLabel={rangeLabel}
                open={explorerOpen}
                onClose={() => setExplorerOpen(false)}
                onJump={(date, center, zoom) => { if (date) onPickDate(date); if (center) map.flyTo({ center, zoom: zoom ?? map.getZoom() }); }}
              />
              {timelineOpen && <CalendarDrawer map={map} onPickMonth={onPickDate} onClose={closeTimeline} drawn={analysed} region={regionArea} detail={detail !== false} />}
              {measure.mode !== 'off' && (
                <div className="measure material" role="status" aria-label="Measurement">
                  <div className="measure__modes">
                    <button type="button" aria-pressed={measure.mode === 'distance'} onClick={() => measure.start('distance')}>Distance</button>
                    <button type="button" aria-pressed={measure.mode === 'area'} onClick={() => measure.start('area')}>Area</button>
                  </div>
                  <p className="measure__value">{measureText || (measure.mode === 'distance' ? 'Click points on the map' : 'Click at least 3 corners')}</p>
                  <p className="measure__hint">{measure.done ? 'Finished.' : 'Double-click or Enter to finish · Esc to cancel'}</p>
                  {measure.polygon && (
                    polyDeg2 <= 25
                      ? <button type="button" className="measure__analyse" onClick={() => { setAnalysed(measure.polygon); setTimelineOpen(true); }}>Analyse this area</button>
                      : <p className="measure__hint">Too large to analyse (max about 5° × 5°). Draw a smaller area.</p>
                  )}
                  <button type="button" className="text-button" onClick={() => { measure.stop(); setAnalysed(null); }}>Clear</button>
                </div>
              )}
              <Toolbar
                map={map}
                explorerOpen={explorerOpen}
                onExplorer={() => setExplorerOpen(!explorerOpen)}
                timelineOpen={timelineOpen}
                onTimeline={() => (timelineOpen ? closeTimeline() : setTimelineOpen(true))}
                shareUrl={() => shareUrl({ center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom() })}
                measuring={measure.mode !== 'off'}
                onMeasure={() => (measure.mode === 'off' ? measure.start('distance') : (measure.stop(), setAnalysed(null)))}
                onCapture={() => captureMap(map, {
                  title: `Fire activity · ${rangeLabel}`,
                  subtitle: `${settings.fireMode === 'raw' ? 'Raw satellite detections (sensor-dependent)' : settings.fireMode === 'hotspots' ? 'Harmonized burning cells' : 'Harmonized activity (VIIRS-equivalent cell-days)'} · ${from} → ${to}`,
                  legend: settings.fireActivity && settings.fireColoring !== 'sensor' ? { colors: flameRamp(), low: settings.fireMode === 'activity' || settings.fireColoring === 'amount' ? 'less' : settings.fireColoring === 'intensity' ? 'low FRP' : 'oldest', high: settings.fireMode === 'activity' || settings.fireColoring === 'amount' ? 'more' : settings.fireColoring === 'intensity' ? 'high FRP' : 'newest' } : null,
                  extra: measureText ? `${measure.mode === 'area' ? 'Area' : 'Distance'}: ${measureText}` : undefined,
                })}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
