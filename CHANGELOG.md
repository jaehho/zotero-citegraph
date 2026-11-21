# Changelog

## 0.1.9 — 2026-11-21

- The graph lays papers out by what they share, not by what they cite: papers that cite the same works, or are cited by the same papers, sit together. Most papers in a field cite the same few hubs, which pulled every paper into one ball. Groups of related papers get a color and a label from words their titles share (Color → group, the new default), and citation links stay faint until you hover or click a paper.
- Rebuilds after a sync or edit no longer keep Zotero's main thread busy for seconds: full texts are read and searched in the scan worker, titles are matched in one pass over each reference section, and the per-item annotation queries are gone.
- Fix the graph canvas running 15 px into the footer.

## 0.1.8 — 2026-11-20

- Fix the item pane's Citations summary counting references outside the
  library: one paper read 115 over 7 chips. The summary and chips now
  both count papers in the library only, and an item whose references
  are all outside it shows the empty dash.

## 0.1.7 — 2026-11-20

- Fix Zotero freezing for seconds on a right-click, Move to Trash or any
  selection (#16). The item-pane section built its collection's graph
  twice per selection on the main thread, reading and scanning every PDF
  each time. Concurrent builds now share one pass, PDF link scanning runs
  in a worker, and each PDF's links are kept until the file changes, in
  `citegraph/pdf-links.json` in the data directory, so a restart does not
  rescan.
- Live suite measures build passes, the longest main-thread stall and
  build times (`CITEGRAPH_DEBUG=1 make check` logs per-phase timings).

## 0.1.6 — 2026-10-16

- Fix the item-pane section being destroyed by Fluent localization: the
  pane/header messages must be attribute form (`.label`/`.tooltiptext`).
  Symptom was a clipped "Citations" text on the sidenav icon and a section
  that rendered as a nameless sliver — clicking the icon looked like a no-op.
- Fix ego rows rendering twice: `onItemChange` and `onRender` both render and
  await the graph build; a sequence token now drops the superseded render.
- Row labels follow the index convention (Scopus, Semantic Scholar, OpenAlex):
  References (outgoing) / Cited by (incoming); was "Builds on"/"Built on by".
- Live suite asserts the real item-pane DOM (the ego check used a mock body,
  which let the Fluent break pass) and treats OpenAlex mutuals as a lower
  bound instead of a pin on the live API snapshot.

## 0.1.5 — 2026-09-24

- Color-by collection/author: evenly spaced hues over the keys in the graph
  (two collections land on opposite hues, not adjacent greens/yellows).
- Collection identity is the full `Parent/Sub` path, so same-named
  subcollections under different parents no longer share a color.
- Multi-membership: color by the deepest path under the opened collection
  when one exists, else the deepest path overall (was `collections[0]` in
  Zotero's arbitrary order).
- Legend stacks name paths; node tooltip shows the primary collection.
- Live suite: build+install the working-tree XPI before running (was testing a
  stale profile XPI); collection-menu check calls `buildCollectionContextMenu`.
- Live suite runs in an isolated Zotero (`~/.local/share/citegraph-test`, hardlinked
  PDFs) on a silent workspace — no longer overwrites your installed plugin or
  kills your running Zotero.


## 0.1.4 — 2026-09-23

- Fix syntax error in 0.1.3 (plugin failed to load). Same single-menu-entry change.


## 0.1.3 — 2026-09-23

- One "Show Citation Graph" per menu (MenuManager only; dropped the DOM duplicate)


## 0.1.2 — 2026-09-23

- Self-test arms only via `/tmp/citegraph-armed` (never a pref). Install and
  normal launch never open a graph.


## 0.1.1 — 2026-09-23

- Self-test is one-shot and closes its tabs. A leftover `selftest` pref no longer
  auto-opens the Connectome (Chiappe) graph on install or every launch.


## 0.1.0 — 2026-09-23

First release. Zotero 10 citation graph.

- Graph tab + item-pane ego (Builds on / Built on by)
- Edges: offline pdf-links / text-doi / extra-doi / title-match; OpenAlex on demand
- `A → B` = A cites B; mutual cites collapse to one double-headed pair
- No physics sliders, no strategy toggles
- Force-graph UI: search, rebuild, size/color, ghost stubs, HTML tooltips
