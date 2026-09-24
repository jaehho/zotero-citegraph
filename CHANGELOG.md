# Changelog

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
