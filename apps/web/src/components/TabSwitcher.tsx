import type { Tab } from '../lib/dataWindows';
import { Segmented, type SegmentedOption } from './Segmented';

const TABS: SegmentedOption<Tab>[] = [
  { id: 'archival', label: 'Archival' },
  { id: 'realtime', label: 'Realtime' },
];

interface Props {
  value: Tab;
  onChange(tab: Tab): void;
}

export function TabSwitcher({ value, onChange }: Props) {
  return <Segmented options={TABS} value={value} onChange={onChange} label="Data source" />;
}
