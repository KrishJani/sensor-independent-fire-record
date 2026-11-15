import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { applyBasemap, BASEMAPS } from '../lib/basemaps';
import { resolveLightPreset, useMapSettings, type MapSettings } from '../lib/mapSettings';
import { applyOverlays } from '../lib/overlays';
import { useColorScheme, type ColorScheme } from '../lib/useColorScheme';
import { useGlobeSpin } from '../lib/useGlobeSpin';
import { BasemapSwitcher } from './BasemapSwitcher';
import { LayersPanel } from './LayersPanel';
import { MapControls } from './MapControls';
import { StatusBar } from './StatusBar';

const INITIAL_CENTER: [number, number] = [-40, 22];
const TERMINATOR_REFRESH_MS = 60_000;

function initialZoom(): number {
  return window.innerWidth < 700 ? 0.6 : 1.6;
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
  /** Called with the map once it exists, and with null when it is removed. */
  onMapReady?(map: mapboxgl.Map | null): void;
}

export function MapView({ onMapReady }: Props = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<mapboxgl.Map | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const { settings, update, reset } = useMapSettings();
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
      center: INITIAL_CENTER,
      zoom: initialZoom(),
      attributionControl: false,
    });
    instance.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-left');
    instance.on('style.load', () =>
      applyAll(instance, latest.current.settings, latest.current.scheme),
    );
    setMap(instance);

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
          <BasemapSwitcher value={settings.basemap} onChange={(basemap) => update({ basemap })} />
          <StatusBar
            map={map}
            showCoordinates={settings.coordinates}
            showScale={settings.scale}
          />
        </>
      )}
    </>
  );
}
