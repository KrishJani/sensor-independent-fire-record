# World Fires guide

<!-- Generated from packages/app-guide/src/index.ts. Edit that file, then run: pnpm --filter @repo/app-guide docs -->

World Fires puts 25 years of NASA satellite fire detections on one consistent scale, and tracks live fires across North America.

## What this is

NASA FIRMS publishes fire hot spots from two sensors. MODIS (2000 onward) sees 1 km pixels. VIIRS (2012 onward) sees 375 m pixels and finds about twice as many fires. Counting raw hot spots across both makes fire activity look like it jumped in 2012.

This site harmonizes the two into one record. Detections go on a common 5.5 km grid. Each day uses VIIRS when it flew, otherwise MODIS scaled by a factor (α) learned from the years when both flew. The result can be compared across 25 years.

The site also tracks live fires across North America, replays the June 2023 Quebec fires, and has a chat copilot that answers questions about the map.

## What each view shows

- **Realtime, Live:** NASA near-real-time detections over North America from the last 48 hours, checked hourly and grouped into incidents. Each incident has weather, nearby places and a short machine-written brief.
- **Realtime, Replay:** the June 2023 Quebec fires played through the same pipeline, 10 days in about 75 seconds. One replay runs for everyone: starting it while it runs joins it.
- **Archival:** the harmonized record for the United States and its nine regions, with fire-prone areas and region outlines. Daily hot spots are loaded only for the showcase periods.
- **Showcase periods:** two periods with daily hot spots on the Archival map. California, Aug–Sep 2020 is harmonized. Quebec, 1–10 June 2023 is raw VIIRS detections, not harmonized, because it is outside the US archive.
- **Calendar:** a Year × Month grid of harmonized fire activity, one square per month, with each month compared with its 2001–2025 median.

## How to

- **Open an incident:** on Realtime, click an incident in the list or a circle on the map. The card shows detections, area, growth, peak power, weather, nearby towns and a brief.
- **Start the replay:** on Realtime, switch to Replay and pick Quebec, June 2023. Pause, stop and change speed in the bar at the top. If a replay is already running, you join it.
- **Read the calendar:** on Archival, open Calendar. Darker squares mean more fire activity. Choose "vs normal" to colour each month against its own median. Hover a month for details, click it to show that month on the map.
- **Raw vs Harmonized:** in the calendar, Raw counts the satellites' own detections and jumps when VIIRS starts in 2012. Harmonized is the record you can compare across years. On the map, the Explorer's Activity and Hotspots modes are harmonized and Raw shows each detection with its sensor.
- **Export CSV:** in the calendar, click CSV to download the months for the current area.
- **Ask the copilot:** open the chat and ask in plain words, for example "What's the biggest fire right now?" It reads what is on the map, and when you ask it can switch views, move the map, open a showcase period or start the replay. Each action shows as a short line in the chat.

## Key terms

- **FRP (fire radiative power):** the heat a fire gives off, in megawatts, as a satellite measures it. It differs by sensor, so it is always labelled MODIS or VIIRS.
- **Cell-day:** one 5.5 km grid cell with at least one detection on one day (UTC). The calendar counts cell-days, not fires.
- **Grid coverage:** the area of the grid cells that have detections, shown as "area with detections". It is larger than the burned area, which this site does not measure.
- **Activity status:** Active means a detection in the last 12 hours, Cooling 12 to 36 hours ago, Inactive more than 36 hours ago.
- **Persistent heat:** many detections on few cells at low power (at least 30 per cell, under 20 MW on average), unlike a moving fire front. The cause is not determined.
- **Gas flare:** most of the incident sits on known gas-flare sites from the EOG VIIRS Nightfire inventory. Not a wildfire.
- **Volcanic heat:** the incident sits on an active volcano. Not a wildfire.

## Known limits

- Satellites miss fires under thick cloud or smoke and between passes. No detection does not mean no fire.
- This deployment loads the summary archive only: calendars, peak FRP and fire-prone areas. Daily hot spots outside the showcase periods, calendars for drawn areas and the world layer are not loaded.
- The archive does not update: it runs through October 2026 for California and through 2025 for the other regions.
- The copilot's calendar and hot-spot tools use demo data (synthetic calendar figures and a five-day California sample), and its answers say so.
- Briefs and copilot answers are machine-written. This is not an alerting system: follow local authorities on evacuations.

## Who built it

Team project built at NASA Space Apps Challenge 2026 by Krish Jani, [Riddhi Raina Prasad](https://github.com/riddhixraina), and [Hemanth](https://github.com/itsmrhem). My contribution:

- Realtime worker pipeline: FIRMS polling through a Queue, incident clustering in Durable Objects, WebSocket streams, and the enrichment Workflow with AI briefs.
- Realtime and replay UI: the live incident list and cards, the Quebec 2023 replay, and its clock and controls.
- Fire copilot agent and chat UI: an Agents SDK chat agent on Workers AI through AI Gateway, with data, live-incident and web search tools.
- Archival tab UI and map work: the calendar drawer, color scales, basemap switcher and FIRMS-style map.

Riddhi Raina Prasad built the harmonization method, historical backfill, ingest Worker, database schema, and the archival API and map layers. Hemanth set up the repository and the initial web app, and ran the original deployment.

Code: [GitHub](https://github.com/KrishJani/sensor-independent-fire-record). Data: NASA FIRMS (LANCE, ESDIS), EOG gas-flare inventory, Open-Meteo, OpenStreetMap and Mapbox.
