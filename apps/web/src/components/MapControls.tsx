import { useEffect, useRef, useState, type ReactNode } from 'react';
import type mapboxgl from 'mapbox-gl';
import { CompassNeedle, LayersIcon, Minus, Plus } from './Icons';

interface Props {
  map: mapboxgl.Map;
  layersOpen: boolean;
  onLayersOpenChange(open: boolean): void;
  layersPanel: ReactNode;
}

export function MapControls({ map, layersOpen, onLayersOpenChange, layersPanel }: Props) {
  const [bearing, setBearing] = useState(map.getBearing());
  const [pitch, setPitch] = useState(map.getPitch());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      setBearing(map.getBearing());
      setPitch(map.getPitch());
    };
    map.on('rotate', sync);
    map.on('pitch', sync);
    return () => {
      map.off('rotate', sync);
      map.off('pitch', sync);
    };
  }, [map]);

  useEffect(() => {
    if (!layersOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onLayersOpenChange(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onLayersOpenChange(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [layersOpen, onLayersOpenChange]);

  const isOriented = Math.abs(bearing) > 0.5 || pitch > 0.5;

  return (
    <div className="map-controls" ref={rootRef}>
      {layersOpen && layersPanel}

      <button
        type="button"
        className={`control compass material ${isOriented ? 'is-visible' : ''}`}
        aria-label="Reset north"
        tabIndex={isOriented ? 0 : -1}
        onClick={() => map.easeTo({ bearing: 0, pitch: 0 })}
      >
        <CompassNeedle style={{ transform: `rotate(${-bearing}deg)` }} />
      </button>

      <button
        type="button"
        className={`control material ${layersOpen ? 'is-active' : ''}`}
        aria-label="Map settings"
        aria-expanded={layersOpen}
        title="Map settings"
        onClick={() => onLayersOpenChange(!layersOpen)}
      >
        <LayersIcon />
      </button>

      <div className="control-group material">
        <button
          type="button"
          className="control"
          aria-label="Zoom in"
          onClick={() => map.zoomIn()}
        >
          <Plus />
        </button>
        <span className="divider" />
        <button
          type="button"
          className="control"
          aria-label="Zoom out"
          onClick={() => map.zoomOut()}
        >
          <Minus />
        </button>
      </div>
    </div>
  );
}
