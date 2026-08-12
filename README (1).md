# lastrenter-data

Self-hosted, licence-clean datasets served to Last Renter property pages (via jsDelivr CDN,
later data.lastrenter.com). Each dataset folder is self-documenting: it carries its own README
with the source, licence, generation method and refresh cadence.

Rules for every dataset in this repo:

1. **Licence-clean only.** CC-BY or equivalent, quoted in the folder README. No non-commercial,
   no display-restricted licences, ever.
2. **Provenance in-repo.** The generation script (or a pointer to it), the exact source URL, and
   the generation date live beside the data. Regeneration must be reproducible.
3. **Attribution baked.** Files carry an `attribution` field; the client renders it.
4. **Honesty.** Coverage limits are documented; absence of data must never be rendered as
   "none"/"safe"/"quiet" by any consumer.

| Dataset | Source | Licence | Updated |
|---|---|---|---|
| `defence-anef/` | Department of Defence, Defence Airfields ANEF (data.gov.au) | CC BY 3.0 AU | 2026-08-11 |
