import { GITHUB_URL, GUIDE, TAGLINE } from '@repo/app-guide';
import { Markdown } from '../chat/Markdown';
import { useDialog } from './useDialog';

interface Props {
  onClose(): void;
  onShowWelcome(): void;
}

/** The guide as a short panel: one line per section, expand for the rest. Same source as the copilot's get_app_help. */
export function HelpPanel({ onClose, onShowWelcome }: Props) {
  const ref = useDialog<HTMLElement>(onClose);
  return (
    <div className="help-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} className="help material" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header className="help__header">
          <h2 id="help-title">Guide</h2>
          <button type="button" className="help__close" onClick={onClose} aria-label="Close guide">×</button>
        </header>
        <div className="help__body">
          <p className="help__tagline">{TAGLINE}</p>
          {GUIDE.map((s, i) => (
            <details key={s.id} className="help__section" open={i === 0}>
              <summary>
                <span className="help__title">{s.title}</span>
                <span className="help__summary">{s.summary}</span>
              </summary>
              <div className="help__text"><Markdown text={s.body} /></div>
            </details>
          ))}
        </div>
        <footer className="help__footer">
          <button type="button" className="text-button" onClick={onShowWelcome}>Show the welcome again</button>
          <a className="text-button" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
        </footer>
      </section>
    </div>
  );
}
