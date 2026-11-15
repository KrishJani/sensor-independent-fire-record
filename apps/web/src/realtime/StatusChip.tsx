import type { ConnectionStatus } from './useRealtimeStream';

const LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  live: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

/** Connection state as text plus a shaped dot (filled, ring, hollow), never color alone. */
export function StatusChip({ status }: { status: ConnectionStatus }) {
  return (
    <span className={`rt-chip rt-chip--${status}`} role="status" aria-live="polite">
      <span className="rt-chip__dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}

export function SourceBadge({ replay }: { replay: boolean }) {
  return (
    <span className={`rt-badge ${replay ? 'rt-badge--replay' : 'rt-badge--live'}`}>
      {replay ? 'Replay' : 'Live'}
    </span>
  );
}
