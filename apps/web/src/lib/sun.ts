import type { Feature, Polygon } from 'geojson';

const RAD = Math.PI / 180;

/** Approximate subsolar point (NOAA low-precision formulas, ~0.5° accuracy). */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = (date.getTime() - startOfYear) / 86_400_000 + 1;

  const declination = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));

  const b = ((2 * Math.PI) / 364) * (dayOfYear - 81);
  const equationOfTimeMin = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);

  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = -15 * (utcHours - 12 + equationOfTimeMin / 60);
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;

  return { lat: declination, lon };
}

/** Polygon covering the night side of the Earth at `date`. */
export function nightPolygon(date: Date): Feature<Polygon> {
  const sun = subsolarPoint(date);
  // tan(0) would put the terminator on the poles; equinox needs a non-zero declination.
  const dec = Math.abs(sun.lat) < 0.01 ? 0.01 : sun.lat;
  const tanDec = Math.tan(dec * RAD);

  const edge: [number, number][] = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const lat = Math.atan(-Math.cos((lon - sun.lon) * RAD) / tanDec) / RAD;
    edge.push([lon, lat]);
  }

  const nightPole = dec > 0 ? -90 : 90;
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[...edge, [180, nightPole], [-180, nightPole], edge[0]]],
    },
  };
}
