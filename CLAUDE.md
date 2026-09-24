# zotero-citegraph

Zotero 10+ citation graph plugin.

- README.md — install and use
- ISSUES.md — API and toolkit gotchas
- CHANGELOG.md — release notes
- DESIGN notes live in code comments, not a separate doc

## Testing

Always `make check` before handoff or commit: unit tests **plus** the live suite
in an isolated Zotero (`scripts/live-test.sh` → `~/.local/share/citegraph-test`).
Never touch the user's profile or installed plugin. `make test` alone is not enough.

## Commands

`make test` · `make check` · `make xpi` · `make dev` / `make run` · `make release`
