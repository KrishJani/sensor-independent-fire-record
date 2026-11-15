// Bottom toolbar (archival): Explorer panel · Timeline (calendar) · Measure · Capture · Locate me · Share link · Method.
import { useState } from 'react';
import type mapboxgl from 'mapbox-gl';

interface Props {
  map: mapboxgl.Map;
  explorerOpen: boolean;
  onExplorer(): void;
  timelineOpen: boolean;
  onTimeline(): void;
  shareUrl(): string;
  measuring: boolean;
  onMeasure(): void;
  onCapture(): Promise<void>;
}

export function Toolbar({ map, explorerOpen, onExplorer, timelineOpen, onTimeline, shareUrl, measuring, onMeasure, onCapture }: Props) {
  const [toast, setToast] = useState<string | null>(null);
  const [method, setMethod] = useState(false);
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); };

  const locate = () => {
    if (!navigator.geolocation) return say('Location is not available in this browser');
    navigator.geolocation.getCurrentPosition(
      (p) => map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 8 }),
      () => say('Location permission was denied'),
      { timeout: 8000 },
    );
  };
  const share = async () => {
    const url = shareUrl();
    try { await navigator.clipboard.writeText(url); say('Link copied'); }
    catch { window.prompt('Copy this link', url); }
  };

  const capture = async () => {
    say('Preparing image…');
    try { await onCapture(); say('Image saved'); } catch { say('Could not capture the map'); }
  };

  return (
    <>
      <nav className="toolbar material" aria-label="Tools">
        <button type="button" aria-pressed={explorerOpen} onClick={onExplorer}><span aria-hidden>☰</span>Explorer</button>
        <button type="button" aria-pressed={timelineOpen} onClick={onTimeline}><span aria-hidden>▦</span>Timeline</button>
        <button type="button" aria-pressed={measuring} onClick={onMeasure}><span aria-hidden>⟷</span>Measure</button>
        <button type="button" onClick={capture}><span aria-hidden>⎙</span>Capture</button>
        <button type="button" onClick={locate}><span aria-hidden>◎</span>Locate</button>
        <button type="button" onClick={share}><span aria-hidden>↗</span>Share</button>
        <button type="button" aria-pressed={method} onClick={() => setMethod(!method)}><span aria-hidden>?</span>Method</button>
      </nav>
      {toast && <div className="toast material" role="status">{toast}</div>}
      {method && (
        <div className="method material" role="dialog" aria-label="How the data is harmonized">
          <h3>How to read this map</h3>
          <p><b>One record, any sensor.</b> MODIS (2000→) and VIIRS (2012→) are put on a common 5.5 km grid. Each day uses VIIRS when it flew, otherwise MODIS scaled by α, which is learned from 2013–2021 when both flew. Busy and quiet months get different α.</p>
          <p><b>Validated out of sample:</b> held-out years are predicted within 5–11% across 8 US regions. MODIS × α matches VIIRS within ±2.3% a year, 2012–2021.</p>
          <p><b>Not fire:</b> gas flares and other industrial heat are removed using an independent flare inventory and shown separately.</p>
          <p><b>Fire-prone areas:</b> statistically significant hot spots (Getis-Ord Gi*, FDR-corrected) of harmonized activity, 2001–2025.</p>
          <button type="button" className="text-button" onClick={() => setMethod(false)}>Close</button>
        </div>
      )}
    </>
  );
}
