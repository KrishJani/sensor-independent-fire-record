# Quebec replay: the "Near Lebel-sur-Quévillon" incident vs. the town's evacuation

Analysis of the `quebec-2023-06` replay (no pipeline changes). Question: was our largest incident, labelled "Near Lebel-sur-Quévillon", large and close to the town before the mandatory evacuation order issued on the evening of Friday, June 2, 2023 (local), allowing about 3 h for near-real-time (NRT) delivery?

## Short answer

**No, not the incident with that label.** Until the evening of June 2 it covered 61–81 km² and its closest detection was 58.7 km from the town. It passed 200 km² only in the 02:18 EDT pass on June 3 (≈05:18 EDT delivered), and became the largest incident on June 5.

**But our data did show fire much closer to the town before the order, filed under other incidents.** A separate cluster (`replay.57`) had a detection 17.8 km from the town in the 13:15 EDT pass on June 2. By the 14:55 EDT pass it had 71 detections in 2 grid cells (40.6 km²), its closest detection was 15.1 km away, and it had just become "significant". With a 3 h delay that reaches a user at about **17:55 EDT on June 2**, which is likely before an evening order. That cluster was small at that point. The large growth near the town (6.2 km, then 4.8 km away, hundreds of km²) shows up only in the overnight passes at 02:18 and 03:09 EDT on June 3 (delivered ≈05:18 and 06:09 EDT), after the order. Those clusters later merged into `.45` and then the big incident (`.6`) on June 5. Merges do not carry history over, so the big incident's card does not show any of this.

## Method

- **Same code as the worker.** The fixture `apps/realtime-worker/data/quebec-2023-06.json` (59,968 VIIRS detections from S-NPP and NOAA-20, archive SP data) went through the realtime-worker's own `assignDetections` and `applyDetections` (bundled from `src/`). Rows were processed one satellite pass (shared timestamp) at a time, in time order.
- **Matches the deployed replay.** The rerun gives the same incident id (`replay-…6`), final area (4,524.3 km²) and centroid (48.92°N, 76.40°W) as the deployed replay.
- **Town centre:** the OpenStreetMap `place=village` node for Lebel-sur-Quévillon (node 2039234616), at **49.053381°N, 76.980544°W**.
- **Distance** is the great-circle distance from the town centre to the **closest detection** (pixel centre, VIIRS ≈375 m) assigned to the incident so far, not to the centroid.
- **Time zones and delay:** times are satellite overpass times (`acq_date` + `acq_time`). EDT = UTC−4. "+3 h" approximates when an NRT product would reach a user.
- **Area** is `affectedAreaKm2`: the area of 0.05° cells (~20 km² each here) that contain a detection. It overstates burned area.

## Timeline of the labelled incident (`replay.6`)

| Milestone | UTC | EDT | UTC +3 h | EDT +3 h | Area | Detections | Closest detection to town |
|---|---|---|---|---|---|---|---|
| First detection | Jun 1 06:56 | Jun 1 02:56 | Jun 1 09:56 | Jun 1 05:56 | 20.3 km² | 1 | 61.9 km |
| Became significant (≥5 detections, ≥2 cells) | Jun 2 06:37 | Jun 2 02:37 | Jun 2 09:37 | Jun 2 05:37 | 60.9 km² | 25 | 60.0 km |
| Area ≥ 50 km² | Jun 2 06:37 | Jun 2 02:37 | Jun 2 09:37 | Jun 2 05:37 | 60.9 km² | 25 | 60.0 km |
| Area ≥ 200 km² | Jun 3 06:18 | Jun 3 02:18 | Jun 3 09:18 | Jun 3 05:18 | 203.2 km² | 355 | 53.0 km |
| Area ≥ 1,000 km² | Jun 5 17:58 | Jun 5 13:58 | Jun 5 20:58 | Jun 5 16:58 | 1,061.9 km² | 1,360 | 48.6 km |
| Largest incident in the replay (first time) | Jun 5 17:59 | Jun 5 13:59 | Jun 5 20:59 | Jun 5 16:59 | 1,490.5 km² | 1,812 | 46.7 km |

- **Significant and 50 km² at the same moment.** It became significant and passed 50 km² in the same pass: its first cell had one detection, and the third cell came on June 2 06:37 UTC.
- **Earlier leaders:** `replay.1` (from June 1), `replay.30` (from June 3 06:18 UTC), and `replay.45` (June 5 17:08 UTC, 51 minutes before `.6` took over).
- **Closest by June 3, 00:00 EDT** (= 04:00 UTC): **58.7 km**, from the June 2 18:55 UTC pass. It was 81.2 km² with 262 detections. With the 3 h delay the answer is the same, because there are no passes between 18:55 UTC and 06:18 UTC.
- **Evening of June 2:** at 18:00 EDT and at 21:00 EDT, both as observed and as delivered +3 h, it was 81.2 km², 262 detections, closest detection 58.7 km away.

### Every pass of `replay.6` until June 3, 12:00 UTC

| UTC | EDT | Satellite | New detections | Cumulative area | Closest so far |
|---|---|---|---|---|---|
| Jun 1 06:56 | Jun 1 02:56 | NOAA-20 | 1 | 20.3 km² | 61.9 km |
| Jun 1 16:43 | Jun 1 12:43 | NOAA-20 | 8 | 20.3 km² | 61.1 km |
| Jun 1 17:34 | Jun 1 13:34 | S-NPP | 6 | 20.3 km² | 60.7 km |
| Jun 2 06:37 | Jun 2 02:37 | NOAA-20 | 10 | 60.9 km² | 60.0 km |
| Jun 2 07:28 | Jun 2 03:28 | S-NPP | 18 | 60.9 km² | 59.8 km |
| Jun 2 16:24 | Jun 2 12:24 | NOAA-20 | 28 | 60.9 km² | 59.0 km |
| Jun 2 17:15 | Jun 2 13:15 | S-NPP | 65 | 60.9 km² | 58.9 km |
| Jun 2 18:04 | Jun 2 14:04 | NOAA-20 | 52 | 81.2 km² | 58.9 km |
| Jun 2 18:55 | Jun 2 14:55 | S-NPP | 74 | 81.2 km² | 58.7 km |
| Jun 3 06:18 | Jun 3 02:18 | NOAA-20 | 93 | 203.2 km² | 53.0 km |
| Jun 3 07:09 | Jun 3 03:09 | S-NPP | 149 | 223.5 km² | 53.0 km |
| Jun 3 07:58 | Jun 3 03:58 | NOAA-20 | 58 | 223.5 km² | 53.0 km |

## The clusters that were actually near the town

Clusters with any detection within 40 km of the town by June 3, 00:00 EDT. Times are pass times; "delivered" is +3 h, in EDT.

**`replay.57`**: closest to the town. Merged into `.46` on Jun 3 06:18 UTC.

| Pass (EDT) | Delivered (EDT) | Detections | Cells | Area | Significant | Closest |
|---|---|---|---|---|---|---|
| Jun 2 13:15 | Jun 2 16:15 | 4 | 1 | 20.3 km² | no | 17.8 km |
| Jun 2 14:04 | Jun 2 17:04 | 22 | 1 | 20.3 km² | no | 16.8 km |
| Jun 2 14:55 | Jun 2 17:55 | 71 | 2 | 40.6 km² | **yes** | **15.1 km** |
| Jun 3 02:18 | Jun 3 05:18 | 172 | 11 | 223.1 km² | yes | 6.2 km |

**`replay.46`**: merged into `.45` on Jun 5 17:08 UTC.

| Pass (EDT) | Delivered (EDT) | Detections | Cells | Area | Significant | Closest |
|---|---|---|---|---|---|---|
| Jun 2 12:24 | Jun 2 15:24 | 2 | 1 | 20.2 km² | no | 36.4 km |
| Jun 2 14:56 | Jun 2 17:56 | 9 | 1 | 20.2 km² | no | 35.5 km |
| Jun 3 02:18 | Jun 3 05:18 | 65 | 9 | 182.2 km² | yes | 25.1 km |
| Jun 3 03:09 | Jun 3 06:09 | 365 | 23 | 466.3 km² | yes | **4.8 km** |

**`replay.45`**: merged into `.6` on Jun 5 18:48 UTC.

| Pass (EDT) | Delivered (EDT) | Detections | Cells | Area | Significant | Closest |
|---|---|---|---|---|---|---|
| Jun 2 12:24 | Jun 2 15:24 | 1 | 1 | 20.3 km² | no | 34.9 km |
| Jun 2 14:55 | Jun 2 17:55 | 54 | 2 | 40.6 km² | yes | 32.2 km |
| Jun 3 02:18 | Jun 3 05:18 | 125 | 8 | 162.7 km² | yes | 25.5 km |
| Jun 3 03:09 | Jun 3 06:09 | 339 | 15 | 305.4 km² | yes | 25.4 km |

**`replay.69`**: 3 detections in 1 cell, 36.3 km away. Never significant.

- **Merge chain:** `.57` → `.46` (Jun 3 06:18 UTC); `.46` → `.45` (Jun 5 17:08 UTC); `.45` → `.6` (Jun 5 18:48 UTC). A merge only redirects later detections. The absorbed incidents keep their own detections, area and brief, and the surviving incident's area never includes them.
- **Closest any detection got by June 3, 00:00 EDT:** **15.1 km**. This is the same 18:55 UTC detection of `replay.57`, nominal confidence, at 49.0991°N, 76.7850°W. With the 3 h delay the answer is the same: delivered about 17:55 EDT on June 2.

## Plain reading

- **What a user would have seen by the evening of June 2** (with the 3 h delay):
  - Fire was being detected **15 km** from Lebel-sur-Quévillon. It was a newly significant incident of 2 cells (40.6 km²) that had first appeared that afternoon.
  - Another cluster 32 km away was the same size.
  - Our "Near Lebel-sur-Quévillon" incident was small (81 km²) and about **59 km** away.
  - Nothing near the town was large.
- **What came after the order:** the near-town clusters were observed reaching hundreds of km² and 5–6 km from the town only in the 02:18 and 03:09 EDT passes on June 3, delivered around 05:18–06:09 EDT. That is after an order issued the previous evening.
- **There was a nighttime gap.** These two satellites made no passes over the area between 14:55 EDT on June 2 and 02:18 EDT on June 3. The data says nothing about the fire's behaviour during those 11 hours.
- **Was it "large and close"?**
  - The labelled incident: no on both counts.
  - The nearest cluster: close (15 km) but not large (40.6 km², 2 cells) before the order.
- **Product issue.** The incident we name after Lebel-sur-Quévillon is not the one that threatened it. It is a large fire about 50–60 km east. The clusters that came within 5–15 km of the town were absorbed into it on June 5 without their history. Someone looking at the big incident's card would not learn that fire reached 5 km of the town on June 3.

## Caveats

- **Archive data, not NRT.** The fixture is standard-processing (SP) archive data. Real NRT data in June 2023 could differ slightly: different detections, small geolocation changes, and NOAA-21 or MODIS passes that are not in this fixture. Extra passes could have shown the overnight growth earlier.
- **The 3 h delay is a flat approximation.** Actual FIRMS NRT latency varies by satellite and pass.
- **I have not verified the order's exact time.** The order time ("evening of Friday June 2") is taken from the request. If it came before about 18:00 EDT, even the 15 km detection would only just have been available.
- **Area overstates burned area.** It is grid-cell coverage, so a single 20 km² cell can stand for a much smaller burning area.
