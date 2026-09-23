# zotero-citegraph

Citation relationships in a clean force graph. Zotero 10+.

`A → B` means **A cites B**. One edge per pair. Real mutual citations get one
double-headed edge, not two arrows. Strategy conflicts are resolved by
confidence and chronology, never drawn twice.

## Install

```
make xpi
```

Zotero → Tools → Plugins → ⚙ → Install Plugin From File →
`build/zotero-citegraph-<version>.xpi`. (Side-loading into `extensions/` is not
enough; Zotero only loads what the plugin manager registers.)

## Use

Right-click a collection or selected items → **Show Citation Graph**.

Top bar: search · Rebuild · Fetch OpenAlex · size-by · color-by · ghosts.
That is the whole control surface. No physics sliders.

Hover a node for title, authors, year, DOI, PDF badge, cited-here.
Hover an edge for `A cites B` / `mutual citations`, provenance (`via`), confidence.

The item pane **Citations** section shows Builds on / Built on by.

Offline strategies (always): pdf-links, text-doi, extra-doi, title-match.
OpenAlex only when you press **Fetch OpenAlex**.

## Develop

```
make test          # edge merge / year-guard / conflict unit tests
make xpi           # zip an XPI into build/
make dev           # source install (quit Zotero first)
make run           # zotero -purgecaches — use after every edit
scripts/selftest.sh  # throwaway profile under /tmp — never the real library
```

Dev loop (official method): quit Zotero → `make dev` once → `make run`.
After edits: quit → `make run`. Release path is still `make xpi` + Install
Plugin From File, or `make release`.

Cache: `<Zotero data dir>/citegraph/openalex.json`.

Updates: GitHub `releases/latest/download/updates.json` via `make release`.
Zotero polls that URL (same as zotero-tray) and installs the new XPI from
`update_link`. Keep **Tools → Plugins → ⚙ → Update Add-ons Automatically**
on. Source installs (`make dev`) do not auto-update.

Gotchas: [ISSUES.md](ISSUES.md).
