import { lazy, Suspense, useEffect, useState } from 'react';
import { closeWhenOtherOpens, panelOpened } from '../lib/panels';
import { ChatIcon } from '../realtime/icons';
import type { AppActions } from '../help/actions';
import type { MapContext } from './context';
import './chat.css';

// The agents SDK is only downloaded once the drawer is first opened.
const ChatPanel = lazy(() => import('./ChatPanel'));

const OPEN_KEY = 'skywalkers77.chat.open.v1';

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

interface Props {
  getContext(): MapContext;
  suggestions: string[];
  /** For the copilot's client-side UI tools. */
  actions: AppActions;
}

/**
 * Collapsible copilot drawer. The agent connection opens on first use and then stays
 * mounted (hidden when collapsed) so a streaming answer is not cut off.
 */
export function ChatDrawer({ getContext, suggestions, actions }: Props) {
  const [open, setOpen] = useState(loadOpen);
  const [used, setUsed] = useState(open);

  useEffect(() => { if (open) panelOpened('chat'); }, [open]);
  // Narrow screens: the calendar opening collapses the copilot (its conversation stays mounted).
  useEffect(() => closeWhenOtherOpens('chat', () => setOpen(false)), []);

  const toggle = (next: boolean) => {
    setOpen(next);
    if (next) setUsed(true);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          className="chat-toggle material"
          aria-label="Open copilot chat"
          onClick={() => toggle(true)}
        >
          <ChatIcon />
          <span>Ask Copilot</span>
        </button>
      )}
      {used && (
        <div className="chat-drawer" hidden={!open}>
          <Suspense fallback={<section className="chat material" aria-busy="true" />}>
            <ChatPanel getContext={getContext} suggestions={suggestions} actions={actions} onClose={() => toggle(false)} />
          </Suspense>
        </div>
      )}
    </>
  );
}
