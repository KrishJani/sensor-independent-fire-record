# Active volcano mask

`volcanoes.json` lists the Holocene volcanoes inside the realtime watch area (`-170,15,-50,72`) that erupted in 2015 or later
(not undersea). Used by `apps/realtime-worker/src/volcano.ts`: an incident whose centroid is within `radiusKm` of one is
labelled **Volcanic heat**, ranked below wildfires and gets no AI brief.

**Source:** Smithsonian Institution, Global Volcanism Program, *Volcanoes of the World* (Holocene volcano list, WFS layer
`GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes`), <https://volcano.si.edu/>. Retrieved 2026-11-24.
Radii are our judgement (default 10 km; larger for Kilauea, Mauna Loa and Popocatepetl rift/flow areas).
To refresh, re-run the query above and keep `radiusKm` overrides.
