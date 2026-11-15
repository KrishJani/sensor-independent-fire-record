import { Ember } from '../components/Ember';
import { fmtClock } from './format';
import { PauseIcon, PlayIcon, StopIcon } from './icons';
import type { ReplayStatus } from './types';
import type { StreamClock } from './useRealtimeStream';
import { useEffect, useRef } from 'react';

/** Clock text driven by rAF straight into the DOM: smooth, and no React render per frame. */
function LiveClock({ clock, fallback }: { clock: StreamClock; fallback: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = '';
    const tick = () => {
      const t = clock.clockAt() ?? fallback;
      const text = fmtClock(t);
      if (text !== shown && ref.current) ref.current.textContent = shown = text;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock, fallback]);
  return <span ref={ref}>{fmtClock(clock.clockAt() ?? fallback)}</span>;
}

interface Props {
  title: string;
  clock: number | null;
  streamClock?: StreamClock;
  status: ReplayStatus;
  progress: number;
  speedLabel: string;
  busy: boolean;
  /** Presenters get transport controls; everyone else watches. */
  presenter: boolean;
  note: string | null;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onRestart(): void;
}

type EndedStatus = 'done' | 'stopped' | 'error';
const ENDED_TEXT: Record<EndedStatus, string> = {
  done: 'Replay finished',
  stopped: 'Replay stopped',
  error: 'Replay failed',
};

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

      {ended ? (
        <div className="rt-hud__ended" role="status">
          <div className="rt-hud__clock">{ENDED_TEXT[p.status as EndedStatus]}</div>
          {p.clock !== null && (
            <p className="rt-hud__ended-at">
              {p.status === 'done' ? 'Played through' : 'Stopped at'} {fmtClock(p.clock)}. Start it again
              to watch the fires develop from June 1.
            </p>
          )}
        </div>
      ) : (
        <div className="rt-hud__clock" aria-live="off">
          {p.clock !== null ? (p.streamClock ? <LiveClock clock={p.streamClock} fallback={p.clock} /> : fmtClock(p.clock)) : <Ember caption="Loading fires" />}
        </div>
      )}

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
          {!p.presenter && !ended ? (
            <span className="rt-hud__watch" title="Replay controls are for the presenter">
              Watch only
            </span>
          ) : ended ? (
            <button type="button" className="rt-button" disabled={p.busy} onClick={p.onRestart}>
              <PlayIcon /> Start again
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
