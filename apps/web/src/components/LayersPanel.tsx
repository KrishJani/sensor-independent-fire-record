import type { ReactNode } from 'react';
import { BASEMAPS } from '../lib/basemaps';
import type { LightSetting, MapSettings, ProjectionId } from '../lib/mapSettings';
import { Segmented, type SegmentedOption } from './Segmented';
import { Toggle } from './Toggle';

const LIGHT_OPTIONS: SegmentedOption<LightSetting>[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'dawn', label: 'Dawn' },
  { id: 'day', label: 'Day' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'night', label: 'Night' },
];

const PROJECTION_OPTIONS: SegmentedOption<ProjectionId>[] = [
  { id: 'globe', label: 'Globe' },
  { id: 'mercator', label: 'Flat' },
];

interface Props {
  settings: MapSettings;
  onChange(patch: Partial<MapSettings>): void;
  onReset(): void;
}

export function LayersPanel({ settings: s, onChange, onReset }: Props) {
  const kind = BASEMAPS[s.basemap].kind;
  const isClassic = kind === 'classic';

  return (
    <div className="layers-panel material" role="dialog" aria-label="Map settings">
      <div className="layers-panel__header">
        <h2>Map Settings</h2>
        <button type="button" className="text-button" onClick={onReset}>
          Reset
        </button>
      </div>

      <Section title="Lighting" note={isClassic ? 'Not available for Terrain' : undefined}>
        <Segmented
          options={LIGHT_OPTIONS}
          value={s.light}
          onChange={(light) => onChange({ light })}
          label="Lighting"
          className="segmented--fill"
          disabled={isClassic}
        />
      </Section>

      <Section title="View">
        <Segmented
          options={PROJECTION_OPTIONS}
          value={s.projection}
          onChange={(projection) => onChange({ projection })}
          label="Projection"
          className="segmented--fill"
        />
        <Toggle
          label="Atmosphere & stars"
          checked={s.atmosphere}
          onChange={(atmosphere) => onChange({ atmosphere })}
        />
        <Toggle
          label="Spin globe"
          checked={s.spin}
          disabled={s.projection !== 'globe'}
          onChange={(spin) => onChange({ spin })}
        />
      </Section>

      <Section title="Map Details">
        <Toggle
          label="Place labels"
          checked={s.placeLabels}
          onChange={(placeLabels) => onChange({ placeLabels })}
        />
        <Toggle
          label="Road labels"
          checked={s.roadLabels}
          onChange={(roadLabels) => onChange({ roadLabels })}
        />
        <Toggle label="Borders" checked={s.borders} onChange={(borders) => onChange({ borders })} />
        <Toggle
          label="Points of interest"
          checked={s.pois}
          onChange={(pois) => onChange({ pois })}
        />
        <Toggle
          label="3D buildings & landmarks"
          checked={s.buildings3d}
          disabled={kind !== 'standard'}
          onChange={(buildings3d) => onChange({ buildings3d })}
        />
      </Section>

      <Section title="Overlays">
        <Toggle
          label="Day / night line"
          checked={s.terminator}
          onChange={(terminator) => onChange({ terminator })}
        />
        <Toggle
          label="Latitude / longitude grid"
          checked={s.graticule}
          onChange={(graticule) => onChange({ graticule })}
        />
        <Toggle
          label="Cursor coordinates"
          checked={s.coordinates}
          onChange={(coordinates) => onChange({ coordinates })}
        />
        <Toggle label="Scale bar" checked={s.scale} onChange={(scale) => onChange({ scale })} />
      </Section>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="layers-panel__section">
      <h3>
        {title}
        {note && <span className="layers-panel__note">{note}</span>}
      </h3>
      {children}
    </section>
  );
}
