import { lazy, Suspense, useState } from 'react';
import { ChatIcon } from '../realtime/icons';
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
}

/**
 * Collapsible copilot drawer. The agent connection opens on first use and then stays
 * mounted (hidden when collapsed) so a streaming answer is not cut off.
 */
export function ChatDrawer({ getContext, suggestions }: Props) {
  const [open, setOpen] = useState(loadOpen);
  const [used, setUsed] = useState(open);

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
            <ChatPanel getContext={getContext} suggestions={suggestions} onClose={() => toggle(false)} />
          </Suspense>
        </div>
      )}
    </>
  );
}
