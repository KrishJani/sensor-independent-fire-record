# `web`: wildfire map and burning activity calendar

React, Vite and TypeScript, deployed on Cloudflare Pages (build: `pnpm --filter web build`, output: `apps/web/dist`).

## Tabs
- **Realtime** (`src/realtime`): live FIRMS incidents and the Quebec 2023 replay from realtime-worker, over
  a WebSocket. Incident list, incident cards with enrichment and AI briefs, replay controls and clock.
- **Archival** (`src/components`): Mapbox GL map of harmonized activity, burning cells or raw detections
  for a date range, with fire-prone areas, industrial heat and region outlines. Clicking a region, or
  measuring an area with the Measure tool and choosing "Analyse this area", opens the Year × Month
  burning activity calendar with anomalies and CSV export. When the API reports a summary-only archive
  (`archival.detail: false` in `/api/meta`), fire layers and calendars for drawn areas show a notice instead.

## Copilot
`src/chat`: a chat drawer connected to `FireCopilotAgent` (`useAgent` and `useAgentChat`, see
`apps/api-worker/CHAT.md`). It sends the current tab, map view and selected incident as context.

## Configuration
`.env.example` lists the variables: `VITE_MAPBOX_TOKEN`, `VITE_REALTIME_URL`, `VITE_API_URL`.
