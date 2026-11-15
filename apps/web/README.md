# `web` — Interactive Wildfire Map & Burning Activity Calendar

React + Vite + TypeScript application deployed on **Cloudflare Pages** (build command: `pnpm --filter web build`, output: `apps/web/dist`).

## Core UI Modules
- **Interactive Map (`Mapbox GL JS` + `Mapbox Draw`)**
  - Lets users draw custom polygons or select administrative regions.
  - Renders harmonized `0.05°` grid cells colored by peak Fire Radiative Power (MW).
  - Includes a zoom-dependent toggle to inspect native **375 m VIIRS** point detections for recent fires (2012–present).
- **Burning Activity Calendar (`Year × Month` Matrix)**
  - Displays harmonized monthly active cell-days and intensity anomalies relative to the 2000–2025 baseline.
  - Supports one-click CSV export and `@media print` situation reports.
- **Emergency Manager Copilot**
  - Side panel connected to the `FireCopilotAgent` (`useAgent` + `useAgentChat`, see `apps/api-worker/CHAT.md`) passing the active polygon geometry and calendar summary as context.
