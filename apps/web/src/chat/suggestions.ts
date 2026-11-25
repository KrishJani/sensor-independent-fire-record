import type { Tab } from '../lib/dataWindows';
import type { RealtimeContext } from '../realtime/RealtimeView';

const REPLAY = [
  "What's the biggest fire right now and how fast is it growing?",
  'Which towns are closest to the largest fires, and which way is the wind blowing?',
  'How many incidents are active in this replay, and which grew most in the last 24 hours?',
];

const LIVE = [
  'Are there any active fire incidents in this area right now?',
  "What's the largest incident and how fast is it growing?",
  'Which towns are near the active fires?',
];

const ARCHIVAL = [
  'What happened in this area in August 2020?',
  'Which months are usually the worst for fires here?',
  'How does this month compare with past years?',
];

/** First on every tab: a newcomer's question, answered from the site guide (get_app_help). */
const ABOUT = 'What is this site?';

export function suggestionsFor(tab: Tab, realtime: RealtimeContext | null): string[] {
  if (tab === 'archival') return [ABOUT, ...ARCHIVAL];
  return [ABOUT, ...(realtime?.stream?.startsWith('replay:') ? REPLAY : LIVE)];
}
