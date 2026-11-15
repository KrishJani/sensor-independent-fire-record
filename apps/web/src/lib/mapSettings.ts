import { useCallback, useEffect, useState } from 'react';
import type { BasemapId } from './basemaps';
import type { ColorScheme } from './useColorScheme';

export type LightSetting = 'auto' | 'dawn' | 'day' | 'dusk' | 'night';
export type LightPreset = Exclude<LightSetting, 'auto'>;
export type ProjectionId = 'globe' | 'mercator';

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
}

export const DEFAULT_SETTINGS: MapSettings = {
  basemap: 'explore',
  light: 'auto',
  projection: 'globe',
  atmosphere: true,
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
