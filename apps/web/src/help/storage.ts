const WELCOME_KEY = 'fires.welcomeDismissed.v1';

/** The welcome card shows once per browser; storage may be blocked (private mode), then it shows per page load. */
export function welcomeDismissed(): boolean {
  try { return localStorage.getItem(WELCOME_KEY) === '1'; } catch { return false; }
}

export function rememberWelcomeDismissed(): void {
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* storage blocked: dismissed for this page view only */ }
}
