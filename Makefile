# zotero-citegraph - citation relationships in a clean force graph.

REPO := jaehho/zotero-citegraph
VERSION := $(shell jq -r .version addon/manifest.json)
XPI := build/zotero-citegraph-$(VERSION).xpi

.PHONY: help xpi test release clean

help:            ## this list
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) \
	  | sed 's/:.*## /\t/' | expand -t18

xpi: $(XPI)      ## build the plugin into build/

$(XPI): $(shell find addon -type f)
	mkdir -p build
	rm -f $@
	cd addon && zip -qrX ../$@ .

test:            ## edge-merge unit tests
	node --test tests/

check:           ## unit tests + live feature suite inside Zotero
	node --test tests/
	scripts/live-test.sh

# Source install (official): https://www.zotero.org/support/dev/client_coding/plugin_development
# 1. quit Zotero  2. make dev  3. zotero -purgecaches
# After later edits: quit, then `make run` (-purgecaches). No reinstall.
PROFILE ?= $(wildcard $(HOME)/.zotero/zotero/*.default*)
ID := $(shell jq -r .applications.zotero.id addon/manifest.json)

dev:             ## proxy-install addon/ from source (quit Zotero first)
	@test -n "$(PROFILE)" || { echo "no Zotero profile found"; exit 1; }
	@if pgrep -x zotero-bin >/dev/null; then echo "quit Zotero first"; exit 1; fi
	rm -f "$(PROFILE)/extensions/$(ID)" "$(PROFILE)/extensions/$(ID).xpi"
	printf '%s' "$(CURDIR)/addon" > "$(PROFILE)/extensions/$(ID)"
	# force one rescan of extensions/ (this is the step that makes the proxy stick)
	sed -i '/extensions\.lastAppBuildId\|extensions\.lastAppVersion/d' "$(PROFILE)/prefs.js"
	@echo "proxy → $(PROFILE)/extensions/$(ID)"
	@echo "start: zotero -purgecaches   (or: make run)"

run:             ## start Zotero reading plugin sources with cold caches
	zotero -purgecaches -jsconsole

UPDATE = .applications.zotero as $$z | {addons: {($$z.id): {updates: [{version, update_link: $$link, update_hash: $$hash, applications: {zotero: ($$z | {strict_min_version, strict_max_version})}}]}}}

build/updates.json: $(XPI)
	jq --arg link "https://github.com/$(REPO)/releases/download/v$(VERSION)/$(notdir $(XPI))" \
	  --arg hash "sha256:$$(sha256sum $(XPI) | cut -d' ' -f1)" \
	  '$(UPDATE)' addon/manifest.json > $@

release: build/updates.json  ## tag v$(VERSION) and publish it as a GitHub release
	@git diff --quiet HEAD || { echo "commit first: the .xpi is built from the tree"; exit 1; }
	git tag v$(VERSION)
	git push origin main v$(VERSION)
	gh release create v$(VERSION) --verify-tag --title v$(VERSION) --notes "" $(XPI) build/updates.json

clean:
	rm -rf build
