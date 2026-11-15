import { BASEMAPS, BASEMAP_ORDER, type BasemapId } from '../lib/basemaps';
import { Segmented, type SegmentedOption } from './Segmented';

const OPTIONS: SegmentedOption<BasemapId>[] = BASEMAP_ORDER.map((id) => ({
  id,
  label: BASEMAPS[id].label,
}));

interface Props {
  value: BasemapId;
  onChange(id: BasemapId): void;
}

export function BasemapSwitcher({ value, onChange }: Props) {
  return (
    <div className="overlay-bottom">
      <Segmented
        options={OPTIONS}
        value={value}
        onChange={onChange}
        label="Map type"
        className="basemap-switcher"
      />
    </div>
  );
}
