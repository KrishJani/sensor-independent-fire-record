/// <reference types="vite/client" />

// Merges into ImportMetaEnv from src/vite-env.d.ts.
interface ImportMetaEnv {
  /** realtime-worker base URL. Default http://localhost:8789 */
  readonly VITE_REALTIME_URL?: string;
  /** api-worker base URL (chat copilot). Default http://localhost:8787 */
  readonly VITE_API_URL?: string;
}
