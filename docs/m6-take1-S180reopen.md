# M6 take-1 metadata (S180-reopen, 2026-07-04)

- File: `video/raw/m6-take1-S180reopen-2026-07-04.mp4` (gitignored — 281MB raw; final render links externally at M7)
- Specs: 3420×2032 retina, 30fps, h264, 2:36.7, Screen Studio-style window capture (gradient margin, enlarged cursor, auto-zooms)
- Live market: 1783172728633 (fixture 18172379), 9/9 devnet txs confirmed err=null, operator: Gabe (within S180-reopen 3-run grant; run 1 of 3)
- Beats captured: terminal start ✓ · UI pool-shift (41.8%→63.1%) ✓ · LOCKED state ✓ · resolve/claim sig prints w/ auto-zoom ✓
- Beats compromised: Explorer beat rendered a clean "Finalized (MAX Confirmations)" close-up (~2:05) but of the CLAIM tx (3yWt864S…) instead of the required RESOLVE CPI tx (3SWRcNWe…), the wrong tx for the Beat-4 validate_stat narration; Beat-6 receipt close-up never scrolled into frame (take ends on terminal)
- Cosmetic: bookmarks bar + Dock visible (crop/retake), Helius 429 retry lines in terminal (authentic, acceptable)
- Both gaps are RE-SHOOTABLE WITHOUT NEW TXS (read-only pages): receipt at /market?id=1783172728633, resolve tx page explorer.solana.com/tx/3SWRcNWeG92gCJb1FkmBpHYsTwK3hBYDwN43Y1WFuyKdPj2QVdDzTYRdhdZ4dnzkK6wfDfSSgu7JGtYHAFwZ8hek?cluster=devnet

## Signatures (run 1, verbatim from operator terminal)
create 4h4bSUQc… · dep1 3o3X43pm… · dep2 2oHj74mZ… · dep3 2fehsph4… · dep4 5Az58GVd… · dep5 5yKceYVn… · lock 2zSkHpNs… · resolve 3SWRcNWe… · claim 3yWt864S… (full sigs in capture log below)
