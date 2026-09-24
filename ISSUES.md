# Gotchas (zotero-citegraph)

Shared Zotero 10 install/API traps: [../ISSUES.md](../ISSUES.md).

force-graph 1.49.5:
- No `.linkDistance()` (use `d3Force('link').distance`), no `.refresh()`, and `.forceUpdate` is Preact’s — not on the graph.
- `autoPauseRedraw` defaults true: paints stop when the sim is idle (controls look dead until you drag).
- Custom `nodeCanvasObject` without `nodePointerAreaPaint` → 1px hit targets.

Edge drawing:
- `subQuad(p0, cx, cy, p1, …)` takes control **scalars**. Passing a point object yields `NaN` and the shaft vanishes while the head still paints.
- One globalAlpha is per draw call. `stroke()` + `fill()` stack; trim the shaft to the head base, or one path/one fill.
- Straight for one-way, bows only for mutual pairs. Arrow tip on the path end tangent, not the chord.

OpenAlex:
- Filter is `doi:a|b|c` (field once). `doi:a|doi:b` → HTTP 400. Held-item DOIs only.
- `IOUtils.exists` / `makeDirectory` are async — do not use `exists()` as a boolean.

Self-test / live suite:
- Armed by the one-shot file `/tmp/citegraph-armed` (never a pref — prefs stick in `prefs.js` and auto-opened the Chiappe graph). The suite deletes the sentinel; cleanup also strips any leftover selftest pref from `user.js`/`prefs.js`.
- `make check` uses `~/.local/share/citegraph-test` (isolated profile+data). Refresh with `scripts/test-zotero-setup.sh` after library changes.
- Content selftest (`window.citegraphSelfTest`) snapshots canvases via `toDataURL` — works on a hidden workspace; grim cannot.
