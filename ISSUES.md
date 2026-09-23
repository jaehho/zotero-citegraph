# Gotchas

Install (Zotero 10):
- Tools → Plugins → Install Plugin From File. Dropping an XPI into `extensions/` does not register it (`startupScanScopes=0`).
- Official source install: proxy file `extensions/<id>` = path to `addon/`, **and** delete `extensions.lastAppBuildId` / `lastAppVersion` from `prefs.js` once so Zotero rescans. Then `zotero -purgecaches` after edits.
- Overwriting the live profile XPI while Zotero runs corrupts the jar cache.

APIs:
- `ZoteroPane.getSelectedCollection()` is gone; use `getSelectedCollections()[0]`.
- `ItemPaneManager.registerSection` needs `header.icon` **and** `header.darkIcon` (not defaulted).
- `Zotero_Tabs.add()` returns `{id, container}`; register `tabHooks.restoreState.<type>` or session restore aborts.
- chrome→content: `wrappedJSObject.citegraphSetData(...)`. CustomEvent chrome→content does not cross.
- MenuManager can register without inserting. Re-assert the item on `popupshowing`. A throwing `onShowing` or a dead icon URL can empty the whole popup.

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
