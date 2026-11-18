# Demo questions (replay)

Asked during or after a `quebec-2023-06` replay, with the map context set to that replay
(`context.realtimeStream = "replay:<id>"`, tab `realtime`). `scripts/demo-chat.mjs` reads the
list below (lines starting with `- "`), asks each question in a fresh chat session and checks the answer.

- "What's the biggest fire right now and how fast is it growing?"
- "Which towns are near the largest fire, and what's the wind doing?"
- "Summarize how the fires developed over the first few days."

What a correct answer contains:

1. The largest incident by area with detections (Quebec, final state: about 4,524 km²) and its
   growth over the last 24 hours, said as a replay of June 2023, with the area called "area with
   detections" (not burned area).
2. The nearest populated places from the incident's enrichment (e.g. Lebel-sur-Quévillon for the
   largest fire), or a clear "unavailable" if the lookup failed, never "no towns"; and the wind
   from the enrichment weather (archive weather at replay time).
3. A day-by-day or phase summary taken from incident first/last-seen times and areas, without
   invented numbers.

Early in a replay (before the first incident), the answer must give the replay clock time and
say nothing has been detected in this area yet, not "there are no fires".

Run against the deployed workers:

```sh
cd apps/api-worker
HOST=nasa-fire-api.<subdomain>.workers.dev RT_HOST=nasa-fire-realtime.<subdomain>.workers.dev node scripts/demo-chat.mjs
# AT=early asks right after starting a fresh replay (empty-result path); OUT=file.json saves the runs.
```
