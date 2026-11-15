import { useCallback, useEffect, useState } from 'react';
import type { BasemapId } from './basemaps';
import type { ColorScheme } from './useColorScheme';

export type LightSetting = 'auto' | 'dawn' | 'day' | 'dusk' | 'night';
export type LightPreset = Exclude<LightSetting, 'auto'>;
export type ProjectionId = 'globe' | 'mercator';
/** activity & hotspots are harmonized (sensor-independent); raw shows the satellites' own pixels. */
export type FireMode = 'activity' | 'hotspots' | 'raw';
/** recency / amount for harmonized modes; sensor / intensity (FRP, not harmonized) only for raw. */
export type FireColoring = 'recency' | 'amount' | 'sensor' | 'intensity';
export type RangePreset = 'day' | 'week' | 'month' | 'season' | 'year';

export interface MapSettings {
  basemap: BasemapId;
  light: LightSetting;
  projection: ProjectionId;
  atmosphere: boolean;
  spin: boolean;
  placeLabels: boolean;
  roadLabels: boolean;
  borders: boolean;
  buildings3d: boolean;
  pois: boolean;
  graticule: boolean;
  terminator: boolean;
  coordinates: boolean;
  scale: boolean;
  fireActivity: boolean;
  proneAreas: boolean;
  industrialHeat: boolean;
  regionOutlines: boolean;
  showViirs: boolean;
  showModis: boolean;
  fireMode: FireMode;
  fireColoring: FireColoring;
  rangePreset: RangePreset;
}

export const DEFAULT_SETTINGS: MapSettings = {
  // FIRMS-like default: flat dark map (grey land, darker ocean) so red hotspots read.
  basemap: 'dark',
  light: 'night',
  projection: 'mercator',
  atmosphere: false,
  spin: false,
  placeLabels: true,
  roadLabels: true,
  borders: true,
  buildings3d: true,
  pois: false,
  graticule: false,
  terminator: false,
  coordinates: true,
  scale: true,
  fireActivity: true,
  proneAreas: false,
  industrialHeat: false,
  regionOutlines: true,
  showViirs: true,
  showModis: true,
  fireMode: 'activity',
  fireColoring: 'recency',
  rangePreset: 'month',
};

const STORAGE_KEY = 'skywalkers77.mapSettings.v1';

function load(): MapSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useMapSettings() {
  const [settings, setSettings] = useState<MapSettings>(load);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const update = useCallback(
    (patch: Partial<MapSettings>) => setSettings((prev) => ({ ...prev, ...patch })),
    [],
  );
  const reset = useCallback(
    () => setSettings((prev) => ({ ...DEFAULT_SETTINGS, basemap: prev.basemap })),
    [],
  );

  return { settings, update, reset };
}

export function resolveLightPreset(light: LightSetting, scheme: ColorScheme): LightPreset {
  if (light !== 'auto') return light;
  return scheme === 'dark' ? 'night' : 'day';
}
