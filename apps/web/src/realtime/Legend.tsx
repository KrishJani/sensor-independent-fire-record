import { fmtInt } from './format';
import { AGE_STOPS, INCIDENT_FRP_STOPS, RAMP } from './layers';

/** Ramp + labelled stops, and a size key: color is never the only cue. */
export function Legend() {
  const gradient = `linear-gradient(90deg, ${RAMP.join(', ')})`;
  return (
    <div className="rt-legend material" aria-label="Map legend">
      <div className="rt-legend__block">
        <span className="rt-legend__title">Peak fire radiative power (MW)</span>
        <span className="rt-legend__ramp" style={{ background: gradient }} aria-hidden="true" />
        <span className="rt-legend__ticks">
          {INCIDENT_FRP_STOPS.map((s, i) => (
            <span key={s}>
              {fmtInt(s)}
              {i === INCIDENT_FRP_STOPS.length - 1 ? '+' : ''}
            </span>
          ))}
        </span>
      </div>
      <span className="divider divider--vertical rt-legend__divider" />
      <div className="rt-legend__block">
        <span className="rt-legend__title">Detection age</span>
        <span
          className="rt-legend__ramp"
          style={{ background: `linear-gradient(90deg, ${AGE_STOPS.map(([h, c]) => `${c} ${Math.round((h / 48) * 100)}%`).join(', ')})` }}
          aria-hidden="true"
        />
        <span className="rt-legend__ticks">
          <span>new</span>
          <span>12 h</span>
          <span>24 h</span>
          <span>48 h</span>
        </span>
      </div>
      <span className="divider divider--vertical rt-legend__divider" />
      <div className="rt-legend__block rt-legend__sizes">
        <span className="rt-legend__circles" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="rt-legend__note">
          Circle area = area with detections
          <br />
          Dots = individual detections, fading over 48 h
        </span>
      </div>
    </div>
  );
}
