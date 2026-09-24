# zotero-citegraph

Zotero 10+ citation graph plugin. Umbrella rules: [../CLAUDE.md](../CLAUDE.md).

- README.md — install and use
- ISSUES.md — force-graph / edge / OpenAlex gotchas (shared Zotero traps in ../ISSUES.md)
- CHANGELOG.md — release notes

## Testing

Always `make check` before handoff or commit: unit tests **plus** the live suite
in an isolated Zotero (`scripts/live-test.sh` → `~/.local/share/citegraph-test`).
Never touch the user's profile or installed plugin. `make test` alone is not enough.

## Commands

`make test` · `make check` · `make xpi` · `make dev` / `make run` · `make release`
