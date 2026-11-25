import { useId, type ReactNode } from 'react';
import { fmtAgo, fmtClock, fmtInt, fmtKm2, fmtMw, fmtShort } from './format';
import { ArrowIcon, BackIcon, InfoIcon } from './icons';
import { fmtLatLon, frpColor } from './IncidentList';
import { ActivityPill, SourceBadge } from './StatusChip';
import { activityOf, briefStaleness, briefTime, FLARE_HELP, isPersistentHeat, PERSISTENT_HELP, titlePlace, type Brief, type IncidentDetail, type IncidentSummary } from './types';

interface Props {
  incident: IncidentSummary;
  detail: IncidentDetail | null;
  detailError: string | null;
  brief: Brief | null;
  clock: number | null;
  replay: boolean;
  onBack(): void;
}

const AREA_HELP =
  'Grid-cell coverage, not burned area: the total area of the ~5 km (0.05°) cells that contain at least one satellite detection. A single hotspot marks a whole cell, so this overstates the area actually burned.';

function Row({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  const helpId = useId();
  return (
    <div className="rt-card__row">
      <dt>
        {label}
        {help && (
          <span className="rt-help" tabIndex={0} aria-describedby={helpId} aria-label="What this means">
            <InfoIcon />
            <span role="tooltip" id={helpId} className="rt-help__tip">
              {help}
            </span>
          </span>
        )}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

export function IncidentCard({ incident: i, detail, detailError, brief, clock, replay, onBack }: Props) {
  const enrichment = detail?.enrichment ?? null;
  // Live: the current reading (same one the copilot uses); otherwise the reading stored with the enrichment.
  const weather = detail?.weatherNow ?? (enrichment?.weather?.status === 'ok' ? enrichment.weather.data : null);
  const places = enrichment?.places?.status === 'ok' ? enrichment.places.data : null;
  const candidates = [
    brief,
    detail?.brief,
    enrichment?.brief?.status === 'ok' ? enrichment.brief.data : null,
  ].filter((b): b is Brief => !!b);
  const shownBrief = candidates.length
    ? candidates.reduce((a, b) => (briefTime(b) > briefTime(a) ? b : a))
    : null;
  // Same brief seen twice (live push without the area, detail with it recovered from the timeline): take the area from either.
  const areaAtBrief = shownBrief
    ? (candidates.find((b) => briefTime(b) === briefTime(shownBrief) && b.affectedAreaKm2 !== undefined)?.affectedAreaKm2 ?? null)
    : null;
  const staleness = briefStaleness(areaAtBrief, i.affectedAreaKm2);
  const activity = activityOf(i, clock);
  const briefFailed = !shownBrief && enrichment?.brief?.status === 'failed';
  const briefSkipped = !shownBrief && enrichment?.brief?.status === 'skipped';
  const nearest = titlePlace(places);
  const title = nearest ? `Near ${nearest.name}` : fmtLatLon(i.centroid);

  return (
    <article className="rt-card" aria-label={`Incident ${title}`}>
      <header className="rt-card__header">
        <button type="button" className="rt-icon-button" aria-label="Back to incident list" onClick={onBack}>
          <BackIcon />
        </button>
        <div className="rt-card__title">
          <h2>{title}</h2>
          <span className="rt-card__sub">
            {nearest ? `${fmtLatLon(i.centroid)} · ` : ''}
            {i.volcano ? (
              `Volcanic heat · ${i.volcano.name}`
            ) : i.status === 'merged' ? (
              'Merged into another incident'
            ) : i.flare ? (
              <span title={FLARE_HELP}>Gas flare (EOG inventory)</span>
            ) : isPersistentHeat(i) ? (
              <span title={PERSISTENT_HELP}>Persistent heat</span>
            ) : (
              'Satellite fire detections'
            )}
          </span>
        </div>
        {i.status !== 'merged' && <ActivityPill activity={activity} />}
        {replay && <SourceBadge replay />}
      </header>

      <dl className="rt-card__grid">
        <Row label="Detections">
          <strong>{fmtInt(i.detections)}</strong>
          <span className="rt-dim">
            {' '}
            · {fmtInt(i.cells)} cells · VIIRS {fmtInt(i.sensors.VIIRS)}, MODIS {fmtInt(i.sensors.MODIS)}
          </span>
        </Row>
        <Row label="Grid coverage" help={AREA_HELP}>
          {fmtKm2(i.affectedAreaKm2)}
          <span className="rt-dim">
            {' '}
            · {i.growthKm2PerDay > 0 ? `+${fmtKm2(i.growthKm2PerDay)} in 24 h` : 'no new cells in 24 h'}
          </span>
        </Row>
        <Row label="Max FRP">
          <span className="rt-swatch" style={{ background: frpColor(i.frpMaxMw) }} aria-hidden="true" />
          {fmtMw(i.frpMaxMw)}
          {i.frpMaxSensor && <span className="rt-dim"> ({i.frpMaxSensor})</span>}
        </Row>
        <Row label="Total FRP">{fmtMw(i.frpTotalMw)}</Row>
        <Row label="First seen">{fmtShort(i.firstSeen)}</Row>
        <Row label="Last seen">
          {fmtShort(i.lastSeen)}
          {clock !== null && <span className="rt-dim"> · {fmtAgo(i.lastSeen, clock)}</span>}
        </Row>
        <Row label="Wind">
          {weather ? (
            <span className="rt-wind">
              <ArrowIcon
                className="rt-wind__arrow"
                style={{ transform: `rotate(${(weather.windDirectionDeg + 180) % 360}deg)` }}
                role="img"
                aria-label={`blowing toward ${Math.round((weather.windDirectionDeg + 180) % 360)} degrees`}
              />
              {Math.round(weather.windSpeedKmh)} km/h from {weather.windFrom}
              <span className="rt-dim">
                {' '}
                · {Math.round(weather.temperatureC)}°C, RH {Math.round(weather.relativeHumidityPct)}%
                {weather.time ? ` · read ${weather.time.slice(5, 10)} ${weather.time.slice(11, 16)} UTC` : ''}
              </span>
            </span>
          ) : (
            <span className="rt-dim">{enrichment ? 'Unavailable' : 'Pending'}</span>
          )}
        </Row>
      </dl>

      <section className="rt-card__section" aria-label="Nearby towns">
        <h3>Nearby towns</h3>
        {places?.length ? (
          <ul className="rt-places">
            {places.slice(0, 4).map((p) => (
              <li key={`${p.name}-${p.distanceKm}`}>
                <span>{p.name}</span>
                <span className="rt-dim">
                  {Math.round(p.distanceKm)} km {p.direction}
                  {p.population ? ` · pop. ${fmtInt(p.population)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rt-dim">{enrichment ? 'None found nearby' : 'Pending enrichment'}</p>
        )}
      </section>

      <section className="rt-card__section rt-brief" aria-label="AI brief" aria-live="polite">
        <h3>
          AI brief
          {shownBrief && <span className="rt-dim">as of {fmtClock(briefTime(shownBrief))}</span>}
        </h3>
        {i.volcano ? (
          <p className="rt-note">
            This heat is at {i.volcano.name} volcano ({i.volcano.distanceKm} km away), not a wildfire, so no AI brief is written. Source: Smithsonian Global Volcanism Program.
          </p>
        ) : i.flare ? (
          <p className="rt-note">
            Most of this heat sits on known gas-flare sites (EOG VIIRS Nightfire inventory), so no AI brief is written.
          </p>
        ) : shownBrief ? (
          <>
            <p>{shownBrief.text}</p>
            {staleness.stale && areaAtBrief !== null && (
              <p className="rt-brief__stale" role="note">
                Out of date: written when grid coverage was {fmtKm2(areaAtBrief)}; it is now {fmtKm2(i.affectedAreaKm2)}.
              </p>
            )}
            <p className="rt-brief__model">
              {shownBrief.model.replace(/^@cf\//, '')} · generated from the numbers above
              {replay ? ' (replay data)' : ''}
            </p>
          </>
        ) : (
          <p className="rt-dim">
            {briefFailed && (detail?.briefFails ?? 0) >= 3
              ? `The brief could not be generated after ${detail?.briefFails} tries.`
              : briefSkipped
                ? 'Replays reuse the briefs written on the first run. This incident did not get one.'
                : 'Brief pending: briefs are written in order of size within a daily limit.'}
          </p>
        )}
      </section>

      {detailError && <p className="rt-error">Could not load details: {detailError}</p>}
    </article>
  );
}
