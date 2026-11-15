import { fmtClock } from './format';
import { PauseIcon, PlayIcon, StopIcon } from './icons';
import type { ReplayStatus } from './types';

interface Props {
  title: string;
  clock: number | null;
  status: ReplayStatus;
  progress: number;
  speedLabel: string;
  busy: boolean;
  note: string | null;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onRestart(): void;
}

const STATUS_TEXT: Record<ReplayStatus, string> = {
  running: 'Playing',
  paused: 'Paused',
  stopped: 'Stopped',
  done: 'Finished',
  error: 'Error',
};

/** Big simulated clock, progress and transport controls for a replay. */
export function ReplayHud(p: Props) {
  const pct = Math.round(Math.min(1, Math.max(0, p.progress)) * 100);
  const ended = p.status === 'stopped' || p.status === 'done' || p.status === 'error';

  return (
    <section className="rt-hud material" aria-label="Replay">
      <div className="rt-hud__top">
        <span className="rt-badge rt-badge--replay">Replay</span>
        <span className="rt-hud__title">{p.title}</span>
        <span className="rt-hud__status">
          {STATUS_TEXT[p.status]} · {p.speedLabel}
        </span>
      </div>

      <div className="rt-hud__clock" aria-live="off">
        {p.clock !== null ? fmtClock(p.clock) : 'Loading…'}
      </div>

      <div className="rt-hud__bottom">
        <div
          className="rt-progress"
          role="progressbar"
          aria-label="Replay progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span className="rt-progress__fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="rt-hud__pct">{pct}%</span>

        <div className="rt-hud__controls">
          {ended ? (
            <button type="button" className="rt-button" disabled={p.busy} onClick={p.onRestart}>
              <PlayIcon /> Restart
            </button>
          ) : (
            <>
              {p.status === 'paused' ? (
                <button
                  type="button"
                  className="rt-hud__ctl"
                  aria-label="Resume replay"
                  title="Resume"
                  disabled={p.busy}
                  onClick={p.onResume}
                >
                  <PlayIcon />
                </button>
              ) : (
                <button
                  type="button"
                  className="rt-hud__ctl"
                  aria-label="Pause replay"
                  title="Pause"
                  disabled={p.busy}
                  onClick={p.onPause}
                >
                  <PauseIcon />
                </button>
              )}
              <button
                type="button"
                className="rt-hud__ctl"
                aria-label="Stop replay"
                title="Stop"
                disabled={p.busy}
                onClick={p.onStop}
              >
                <StopIcon />
              </button>
            </>
          )}
        </div>
      </div>
      {p.note && <p className="rt-hud__note">{p.note}</p>}
    </section>
  );
}
