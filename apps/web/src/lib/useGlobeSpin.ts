import { useEffect } from 'react';
import type mapboxgl from 'mapbox-gl';

const SECONDS_PER_REVOLUTION = 150;
const MAX_SPIN_ZOOM = 4;

export function useGlobeSpin(map: mapboxgl.Map | null, enabled: boolean) {
  useEffect(() => {
    if (!map || !enabled) return;

    let interacting = false;
    let stopped = false;

    const spin = () => {
      if (stopped || interacting || map.getZoom() > MAX_SPIN_ZOOM) return;
      const center = map.getCenter();
      center.lng -= 360 / SECONDS_PER_REVOLUTION;
      map.easeTo({ center, duration: 1000, easing: (t) => t });
    };

    // Deferred so a user animation that interrupted the spin (zoom buttons, flyTo)
    // has started before we decide whether to keep spinning.
    const resume = () =>
      requestAnimationFrame(() => {
        if (!map.isMoving()) spin();
      });
    const hold = () => {
      interacting = true;
    };
    const release = () => {
      interacting = false;
      resume();
    };

    map.on('mousedown', hold);
    map.on('touchstart', hold);
    map.on('mouseup', release);
    map.on('touchend', release);
    map.on('dragend', release);
    map.on('moveend', resume);
    spin();

    return () => {
      stopped = true;
      map.off('mousedown', hold);
      map.off('touchstart', hold);
      map.off('mouseup', release);
      map.off('touchend', release);
      map.off('dragend', release);
      map.off('moveend', resume);
    };
  }, [map, enabled]);
}
