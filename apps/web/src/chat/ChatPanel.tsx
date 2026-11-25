import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import type { UIMessage } from 'ai';
import { API_URL } from '../realtime/config';
import { CloseIcon, SendIcon, StopIcon } from '../realtime/icons';
import type { AppActions } from '../help/actions';
import type { MapContext } from './context';
import { Markdown } from './Markdown';
import { runUiTool, UI_TOOL_NAMES, type UiToolOutput } from './uiTools';

const SESSION_KEY = 'copilotSessionId';

/** One chat session per browser, as in apps/api-worker/CHAT.md. */
function sessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const TOOL_LABELS: Record<string, [running: string, done: string]> = {
  get_live_incidents: ['Checking fire incidents', 'Checked fire incidents'],
  get_spots_summary: ['Summarizing detections', 'Summarized detections'],
  get_calendar: ['Reading the activity calendar', 'Read the activity calendar'],
  get_month_to_date: ['Comparing this month', 'Compared this month'],
  web_search: ['Searching the web', 'Searched the web'],
  web_fetch: ['Reading a page', 'Read a page'],
  remember: ['Saving a note', 'Saved a note'],
  recall: ['Recalling notes', 'Recalled notes'],
  get_app_help: ['Reading the site guide', 'Read the site guide'],
};

interface ToolPart {
  type: string;
  state?: string;
  toolName?: string;
  output?: unknown;
}

function ToolChip({ part }: { part: ToolPart }) {
  const name = part.type === 'dynamic-tool' ? (part.toolName ?? 'tool') : part.type.slice(5);
  const state = part.state ?? '';
  // UI tools (the copilot acting on the map) show what they did: "Switched to Replay".
  const ui = UI_TOOL_NAMES.has(name) ? (part.output as UiToolOutput | undefined) : undefined;
  const [running, done] = ui?.summary
    ? [ui.summary, ui.summary]
    : UI_TOOL_NAMES.has(name)
      ? ['Updating the map', 'Updated the map']
      : (TOOL_LABELS[name] ?? [`Running ${name}`, `Ran ${name}`]);
  if (ui && !ui.ok) {
    return (
      <span className="chat-tool is-done is-failed">
        <span className="chat-tool__dot" aria-hidden="true" />
        {ui.summary}
      </span>
    );
  }
  const failed = state === 'output-error' || state === 'output-denied';
  const finished = state === 'output-available' || failed;
  return (
    <span className={`chat-tool ${finished ? 'is-done' : 'is-running'} ${failed ? 'is-failed' : ''}`}>
      <span className="chat-tool__dot" aria-hidden="true" />
      {failed ? `${running} failed` : finished ? done : `${running}…`}
    </span>
  );
}

function Message({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`chat-msg ${isUser ? 'chat-msg--user' : 'chat-msg--assistant'}`}>
      {message.parts.map((part, i) => {
        if (part.type === 'text') {
          return isUser ? (
            <p key={i} className="chat-msg__plain">
              {part.text}
            </p>
          ) : (
            <Markdown key={i} text={part.text} />
          );
        }
        if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
          return <ToolChip key={i} part={part as ToolPart} />;
        }
        return null;
      })}
    </div>
  );
}

interface PanelProps {
  getContext(): MapContext;
  suggestions: string[];
  actions: AppActions;
  onClose(): void;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function ChatPanel({ getContext, suggestions, actions, onClose }: PanelProps) {
  const [id] = useState(sessionId);
  const api = new URL(API_URL);
  const agent = useAgent({
    agent: 'FireCopilotAgent',
    name: id,
    host: api.host,
    protocol: api.protocol === 'https:' ? 'wss' : 'ws',
  });
  const latestContext = useRef(getContext);
  latestContext.current = getContext;
  const latestActions = useRef(actions);
  latestActions.current = actions;
  const { messages, sendMessage, status, stop, clearHistory, error } = useAgentChat({
    agent,
    // Sent with every message; a function so it always reads the current map state.
    body: () => ({ context: latestContext.current() }),
    // The copilot's UI tools run here, on the map; the result carries the map context after the action
    // (the server continues the turn with it, since the continuation reuses the original request body).
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (!UI_TOOL_NAMES.has(toolCall.toolName)) return;
      const out = await runUiTool(toolCall.toolName, toolCall.input, latestActions.current);
      // Let the tab switch / replay stream reach React state before reading the context.
      for (let i = 0; i < 10; i++) {
        await settle(150);
        const ctx = latestContext.current();
        if (toolCall.toolName !== 'start_replay' || ctx.realtimeStream?.startsWith('replay:')) break;
      }
      addToolOutput({ toolCallId: toolCall.toolCallId, output: { ...out, context: latestContext.current() } });
    },
  });

  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  useEffect(() => inputRef.current?.focus(), []);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    void sendMessage({ text: t });
    setDraft('');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(draft);
    }
  };

  const last = messages.at(-1);
  const waiting =
    status === 'submitted' ||
    (status === 'streaming' && last?.role === 'assistant' && !last.parts.some((p) => p.type === 'text'));

  return (
    <section className="chat material" aria-label="Fire copilot chat">
      <header className="chat__header">
        <h2>Copilot</h2>
        <span className="chat__hint">Answers use the area on screen</span>
        {messages.length > 0 && (
          <button type="button" className="text-button" onClick={clearHistory} disabled={busy}>
            Clear
          </button>
        )}
        <button type="button" className="chat__close" aria-label="Close chat" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      <div className="chat__messages" ref={listRef} aria-live="polite">
        {messages.length === 0 && (
          <div className="chat__empty">
            <p>Ask about the fires on the map. Try:</p>
            <div className="chat__suggestions">
              {suggestions.map((s) => (
                <button key={s} type="button" className="chat__suggestion" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {waiting && (
          <div className="chat-typing" aria-label="Copilot is thinking">
            <span />
            <span />
            <span />
          </div>
        )}
        {error && <p className="chat__error">Something went wrong: {error.message}</p>}
      </div>

      <form className="chat__form" onSubmit={onSubmit}>
        <textarea
          ref={inputRef}
          className="chat__input"
          rows={1}
          value={draft}
          placeholder="Ask about these fires…"
          aria-label="Message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button type="button" className="chat__send" aria-label="Stop" onClick={() => void stop()}>
            <StopIcon />
          </button>
        ) : (
          <button type="submit" className="chat__send" aria-label="Send" disabled={!draft.trim()}>
            <SendIcon />
          </button>
        )}
      </form>
    </section>
  );
}

