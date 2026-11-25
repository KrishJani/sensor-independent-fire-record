import { TAGLINE } from '@repo/app-guide';
import type { AppActions } from './actions';
import { useDialog } from './useDialog';

interface Props {
  actions: AppActions;
  onClose(): void;
}

/** First-visit card over the map: what the site is, and three ways in. */
export function Welcome({ actions, onClose }: Props) {
  const ref = useDialog<HTMLDivElement>(onClose, '.welcome__primary');
  const go = (fn: () => void) => () => { fn(); onClose(); };
  return (
    <div className="welcome-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="welcome material" role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-text">
        <button type="button" className="welcome__close" onClick={onClose} aria-label="Close welcome">×</button>
        <h2 id="welcome-title">World Fires</h2>
        <p id="welcome-text">{TAGLINE}</p>
        <div className="welcome__actions">
          <button type="button" className="welcome__primary" onClick={go(() => void actions.startReplay('quebec-2023-06'))}>
            Watch the Quebec 2023 replay
          </button>
          <button type="button" className="welcome__secondary" onClick={go(actions.showLive)}>See live fires</button>
          <button type="button" className="welcome__secondary" onClick={go(() => void actions.openShowcase('california-2020-08'))}>
            Explore 25 years of history
          </button>
        </div>
        <p className="welcome__hint">The <b>?</b> button at the top reopens the guide.</p>
      </div>
    </div>
  );
}
