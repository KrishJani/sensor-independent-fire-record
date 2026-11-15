// Capture the map as a self-explaining PNG for briefings: title strip (what / when / mode), legend,
// and footer with sources, generation time and the attribution Mapbox's terms require on exports.
import type mapboxgl from 'mapbox-gl';

export interface CaptureInfo {
  title: string; // e.g. "Fire activity · Aug 2020"
  subtitle: string; // e.g. "Harmonized (VIIRS-equivalent cell-days) · 2020-08-01 → 2020-08-31"
  legend: { colors: string[]; low: string; high: string } | null;
  extra?: string; // e.g. measurement readout
}

/** Grab the WebGL canvas on the next render (works without preserveDrawingBuffer). */
function mapImage(map: mapboxgl.Map): Promise<HTMLCanvasElement> {
  return new Promise((resolve) => {
    map.once('render', () => {
      const src = map.getCanvas();
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d')!.drawImage(src, 0, 0);
      resolve(c);
    });
    map.triggerRepaint();
  });
}

export async function captureMap(map: mapboxgl.Map, info: CaptureInfo): Promise<void> {
  const img = await mapImage(map);
  const dpr = img.width / map.getCanvas().clientWidth || 1;
  const head = Math.round(58 * dpr), foot = Math.round(30 * dpr);
  const out = document.createElement('canvas');
  out.width = img.width;
  out.height = img.height + head + foot;
  const g = out.getContext('2d')!;
  const font = (w: number, px: number) => `${w} ${Math.round(px * dpr)}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;

  g.fillStyle = '#111418';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(img, 0, head);

  // Title strip
  g.fillStyle = '#ffffff';
  g.font = font(600, 17);
  g.fillText(info.title, 14 * dpr, 24 * dpr);
  g.fillStyle = 'rgba(255,255,255,0.72)';
  g.font = font(400, 12.5);
  g.fillText(info.subtitle, 14 * dpr, 44 * dpr);
  if (info.legend) {
    const w = 22 * dpr, h = 9 * dpr, n = info.legend.colors.length;
    g.font = font(400, 11);
    const hiW = g.measureText(info.legend.high).width;
    let x = out.width - 14 * dpr - hiW - n * w - 8 * dpr;
    const y = 30 * dpr;
    g.fillStyle = 'rgba(255,255,255,0.72)';
    g.textAlign = 'right';
    g.fillText(info.legend.low, x - 6 * dpr, y + h);
    g.textAlign = 'left';
    for (const c of info.legend.colors) { g.fillStyle = c; g.fillRect(x, y, w, h); x += w; }
    g.fillStyle = 'rgba(255,255,255,0.72)';
    g.fillText(info.legend.high, x + 6 * dpr, y + h);
  }
  if (info.extra) {
    g.fillStyle = 'rgba(17,20,24,0.78)';
    g.font = font(600, 13);
    const tw = g.measureText(info.extra).width;
    g.fillRect(14 * dpr, head + 12 * dpr, tw + 20 * dpr, 26 * dpr);
    g.fillStyle = '#ffffff';
    g.fillText(info.extra, 24 * dpr, head + 30 * dpr);
  }

  // Footer: sources, time, required attribution
  g.fillStyle = 'rgba(255,255,255,0.62)';
  g.font = font(400, 11);
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  g.fillText(`Data: NASA FIRMS (MODIS, VIIRS), harmonized · Generated ${when}`, 14 * dpr, out.height - 11 * dpr);
  g.textAlign = 'right';
  g.fillText('© Mapbox © OpenStreetMap', out.width - 14 * dpr, out.height - 11 * dpr);

  const blob: Blob = await new Promise((r) => out.toBlob((b) => r(b!), 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fire-map_${info.subtitle.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? 'view'}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
