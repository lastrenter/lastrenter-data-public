# Defence Airfields ANEF (aircraft-noise contours)

ANEF band polygons for 14 Australian Defence airfields, as simplified GeoJSON, one file per base
plus `index.json` (per-base bounding boxes, used by the client as a cheap prefilter so 99% of
addresses never fetch polygon data).

- **Source:** Department of Defence, "Defence Airfields Australian Noise Exposure Forecast (ANEF)"
  https://data.gov.au/data/dataset/defence-airfields-australian-noise-exposure-forecast-anef
  (resource `australian-defence-airfields-anef-anec.kml`, metadata modified 2023-08-09)
- **Licence:** Creative Commons Attribution 3.0 Australia (stated on the dataset record)
- **Attribution rendered by the client:** "Defence" in the row sub-line; full form
  "Department of Defence, CC BY 3.0 AU"
- **Generated:** 2026-08-11 by `convert_defence.js` (kept with the project tooling):
  KML → per-polygon parse → Douglas-Peucker simplification (tolerance 0.0003°, ~30 m; 69,646
  points → 4,536) → per-base FeatureCollections. Feature properties: `base`, `band`
  (e.g. "20-25", "40+"), `bandMin` (numeric lower bound for ranking).
- **Data fix applied:** the source KML mislabels two placemarks (a "Townsville"-named 40+ ring
  that is geographically at Amberley, and an "Amberley"-named 40+ ring at Williamtown). Base
  identity is therefore assigned by geometry (nearest airfield to each polygon's centroid), not
  by placemark label. Also normalised: source misspelling "Williamown" → "Williamtown";
  "RAAF Base Albatross" → "HMAS Albatross".
- **Verification:** point-tested (`verify_defence.js`): on-base Williamtown/Amberley → 40+;
  Windsor NSW → 20-25 (RAAF Richmond); Garbutt QLD → 30-35 (Townsville); Sydney/Newcastle/
  Brisbane CBDs → no match.
- **Honesty limits:** ANEF forecasts are per-base snapshots updated every 5-10 years by Defence
  (e.g. Williamtown 2025 ANEF includes F-35A modelling). Contours map ONLY the modelled ANEF 15/20+
  bands; Defence's own guidance says properties outside the zones "may still experience aircraft
  noise" — clients must render a non-match as no-data, never as "quiet".
- **Refresh:** re-check the data.gov.au record roughly yearly; regenerate on change.
