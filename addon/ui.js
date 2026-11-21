/* Chrome-side UI: menus, graph tab, item-pane ego. */
"use strict";

class CitegraphUI {
  constructor({ rootURI, id, version, resRoot }) {
    this.rootURI = rootURI;
    this.id = id;
    this.version = version;
    this.resRoot = resRoot || "citegraph";
    this.menuIDs = [];
    this.paneID = null;
    this.browsers = new Map(); // tabID -> browser
    this.adapterCache = new Map(); // scopeKey -> {graph, builtAt}
    this.building = new Map(); // scopeKey -> in-flight build promise
    this.buildCount = 0; // full extraction passes, for the live suite
    this.scanner = new PdfScanner("resource://" + this.resRoot + "/scan-worker.js");
    this.pdfLinks = new PdfLinkCache();
    this.tabHooksInstalled = new WeakSet();
  }

  async startup() {
    for (const win of Zotero.getMainWindows()) this.attach(win);
    this.registerMenus();
    this.registerItemPane();
  }

  ensureFTL(win) {
    try {
      // Bare filename: Zotero auto-registers locale/<locale>/*.ftl into Fluent.
      win.MozXULElement?.insertFTLIfNeeded?.("citegraph.ftl");
    } catch (e) {
      log("FTL insert failed: " + e);
    }
  }

  shutdown() {
    this.unregisterMenus();
    if (this.paneID && Zotero.ItemPaneManager?.unregisterSection) {
      try {
        Zotero.ItemPaneManager.unregisterSection(this.paneID);
      } catch (e) {}
    }
    this.browsers.clear();
    this.adapterCache.clear();
    this.building.clear();
    this.scanner.stop();
    this.pdfLinks.clear();
  }

  attach(win) {
    this.installTabHooks(win);
    this.ensureFTL(win);
  }

  detach() {}

  // -- menus ---------------------------------------------------------------
  // MenuManager only. A DOM backup duplicates the entry ("Show Citation Graph"
  // twice) once MenuManager actually inserts. Keep one path.
  // A throwing onShowing or a bad icon URL can empty the whole popup — guard both.

  registerMenus() {
    const iconURL = this.rootURI + "content/icons/graph.svg";
    const label = "Show Citation Graph";
    const guard = (fn) => (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        log("menu handler: " + e);
      }
    };
    const forceLabel = (el) => {
      try {
        if (el && !el.getAttribute("label")) el.setAttribute("label", label);
      } catch (e) {}
    };

    const mm = Zotero.MenuManager;
    if (!mm?.registerMenu) {
      log("MenuManager missing — DOM fallback");
      for (const win of Zotero.getMainWindows()) this.injectMenusDOM(win);
      return;
    }
    this.menuIDs.push(
      mm.registerMenu({
        menuID: "citegraph-collection",
        pluginID: this.id,
        target: "main/library/collection",
        menus: [
          {
            menuType: "menuitem",
            l10nID: "citegraph-menu-show",
            icon: iconURL,
            onShowing: guard((event) => forceLabel(event?.target)),
            onCommand: guard(() => void this.openFromCollection({})),
          },
        ],
      }),
      mm.registerMenu({
        menuID: "citegraph-item",
        pluginID: this.id,
        target: "main/library/item",
        menus: [
          {
            menuType: "menuitem",
            l10nID: "citegraph-menu-show",
            icon: iconURL,
            onShowing: guard((event, ctx) => {
              forceLabel(event?.target);
              const items = (ctx?.items || []).filter((i) => i?.isRegularItem?.() && !i.deleted);
              const show = items.length > 0;
              if (typeof ctx?.setVisible === "function") ctx.setVisible(show);
              else if (event?.target) event.target.hidden = !show;
            }),
            onCommand: guard((event, ctx) => {
              void this.openFromContext({ items: ctx?.items });
            }),
          },
        ],
      }),
    );
  }

  injectMenusDOM(win) {
    const add = (popupId, handler) => {
      const popup = win.document.getElementById(popupId);
      if (!popup || popup.querySelector(".citegraph-show")) return;
      const item = win.document.createXULElement("menuitem");
      item.className = "citegraph-show";
      item.setAttribute("label", "Show Citation Graph");
      item.addEventListener("command", () => {
        try {
          handler();
        } catch (e) {
          Zotero.logError(e);
        }
      });
      popup.appendChild(item);
    };
    add("zotero-collectionmenu", () => this.openFromCollection({}));
    add("zotero-itemmenu", () =>
      this.openFromContext({ items: win.ZoteroPane?.getSelectedItems?.() }),
    );
  }

  findOurMenuitem(popup) {
    if (!popup) return null;
    const all = [...popup.querySelectorAll("menuitem")];
    const hits = all.filter((el) => {
      const l = (el.getAttribute("label") || "").toLowerCase();
      const id = (
        el.getAttribute("data-l10n-id") ||
        el.getAttribute("l10n-id") ||
        el.className ||
        ""
      ).toLowerCase();
      return (
        id.includes("citegraph") ||
        id.includes("citation-graph") ||
        l.includes("citation graph") ||
        /citegraph/.test(id)
      );
    });
    // collapse duplicates (MenuManager + a stale DOM node)
    for (let i = 1; i < hits.length; i++) {
      try {
        hits[i].remove();
      } catch (e) {}
    }
    return hits[0] || null;
  }

  unregisterMenus() {
    for (const id of this.menuIDs) {
      try {
        Zotero.MenuManager?.unregisterMenu?.(id);
      } catch (e) {}
    }
    this.menuIDs = [];
    for (const win of Zotero.getMainWindows()) {
      for (const el of win.document.querySelectorAll(".citegraph-show")) el.remove();
    }
  }

  // -- item pane ego -------------------------------------------------------

  registerItemPane() {
    const manager = Zotero.ItemPaneManager;
    if (!manager?.registerSection) return;
    // rootURI (jar:/file:), not chrome:// — chrome is flaky across Zotero 9/10.
    // icon AND darkIcon are required; darkIcon is not defaulted to icon.
    const icon = this.rootURI + "content/icons/graph.svg";
    this.paneID = manager.registerSection({
      paneID: "citegraph-ego",
      pluginID: this.id,
      header: {
        l10nID: "citegraph-pane-header",
        icon,
        darkIcon: icon,
      },
      sidenav: {
        l10nID: "citegraph-pane-sidenav",
        icon,
        darkIcon: icon,
      },
      onItemChange: ({ body, item, setEnabled, setSectionSummary }) => {
        void this.renderEgo(body, item, setEnabled, setSectionSummary);
      },
      onRender: ({ body, item, setSectionSummary }) => {
        void this.renderEgo(body, item, null, setSectionSummary);
      },
    });
  }

  async renderEgo(body, item, setEnabled, setSectionSummary) {
    // onItemChange and onRender both fire per selection change. Each call
    // wipes the body, then awaits the graph build; without a sequence token
    // the first-finished call appends its rows after a later call's wipe
    // already ran — every row renders twice.
    const seq = (body._citegraphSeq = (body._citegraphSeq || 0) + 1);
    body.textContent = "";
    if (!item?.isRegularItem?.()) {
      setEnabled?.(false);
      return;
    }
    setEnabled?.(true);
    const graph = await this.graphForItem(item);
    if (seq !== body._citegraphSeq) return; // a newer render owns this body
    // Count and show held items only. Ghosts (cited DOIs not in the library)
    // have no chip, so counting them made "115" sit over a handful of chips.
    const held = new Map(graph.nodes.filter((n) => !n.ghost).map((n) => [n.id, n]));
    const outgoing = graph.edges.filter((e) => e.from === item.key && held.has(e.to));
    const incoming = graph.edges.filter((e) => e.to === item.key && held.has(e.from));
    setSectionSummary?.(`${outgoing.length} ← → ${incoming.length}`);

    const doc = body.ownerDocument;
    const row = (label, list, dir) => {
      const wrap = doc.createElement("div");
      wrap.style.cssText = "margin:4px 0";
      const h = doc.createElement("div");
      h.textContent = label;
      h.style.cssText = "opacity:.7;font-size:11px;margin-bottom:2px";
      wrap.appendChild(h);
      const chips = doc.createElement("div");
      chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";
      if (!list.length) {
        const none = doc.createElement("span");
        none.textContent = "—";
        none.style.opacity = "0.5";
        chips.appendChild(none);
      }
      for (const e of list) {
        const other = held.get(dir === "out" ? e.to : e.from);
        const chip = doc.createElement("button");
        chip.textContent = other.year ? `${shortAuthor(other)} ${other.year}` : shortAuthor(other);
        chip.title = other.title;
        chip.style.cssText =
          "border:1px solid color-mix(in srgb, currentColor 25%, transparent);" +
          "background:transparent;color:inherit;border-radius:999px;" +
          "padding:2px 8px;font-size:12px;cursor:pointer";
        chip.addEventListener("click", () => {
          if (other.itemID) {
            const pane = Zotero.getActiveZoteroPane();
            pane?.selectItem(other.itemID);
          }
        });
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
      return wrap;
    };
    // Index-standard terminology (Scopus / Semantic Scholar tabs, OpenAlex
    // "Referenced works" / "Cited by"): outgoing = References, incoming =
    // Cited by.
    body.appendChild(row("References", outgoing, "out"));
    body.appendChild(row("Cited by", incoming, "in"));
  }

  // -- graph tab -----------------------------------------------------------

  installTabHooks(win) {
    const tabs = win.Zotero_Tabs;
    if (!tabs || this.tabHooksInstalled.has(tabs)) return;
    this.tabHooksInstalled.add(tabs);
    tabs.tabHooks = tabs.tabHooks || {};
    tabs.tabHooks = tabs.tabHooks || {};
    tabs.tabHooks.restoreState = tabs.tabHooks.restoreState || {};
    tabs.tabHooks.getTitle = tabs.tabHooks.getTitle || {};
    // Mandatory: tabs.js destructures `{ itemID } = await restoreStateHook()`.
    // A missing hook returns undefined and aborts restore for every later tab.
    tabs.tabHooks.restoreState.citegraph = async () => ({ itemID: null });
    tabs.tabHooks.getTitle.citegraph = async (tab) =>
      String(tab?.data?.title || "Citation Graph");
  }

  async openFromContext(ctx) {
    const pane = this.paneFor(ctx);
    const items = (ctx?.items?.length ? ctx.items : pane?.getSelectedItems?.() || []).filter(
      (i) => i?.isRegularItem?.() && !i.deleted,
    );
    if (!items.length) {
      log("openFromContext: no items");
      return;
    }
    await this.openGraph({ kind: "selection", items, title: "Citation Graph" });
  }

  async openFromCollection(ctx) {
    const pane = this.paneFor(ctx) || this.paneFor();
    // Zotero 10: getSelectedCollection() was removed; use the plural form.
    let collections = [];
    try {
      collections = pane?.getSelectedCollections?.() || [];
    } catch (e) {}
    const collection = collections[0];
    if (!collection) {
      log("openFromCollection: no collection selected");
      return;
    }
    await this.openGraph({
      kind: "collection",
      collection,
      title: collection.name || "Citation Graph",
    });
  }

  paneFor(ctx) {
    const win = ctx?.menuElem?.ownerGlobal || Zotero.getActiveZoteroPane?.()?.window;
    return win?.ZoteroPane || Zotero.getActiveZoteroPane();
  }

  readPrefs() {
    const p = (name, dflt) => {
      try {
        const v = Zotero.Prefs.get("extensions.zotero-citegraph." + name, true);
        return v === undefined || v === null ? dflt : v;
      } catch (e) {
        return dflt;
      }
    };
    return {
      sizeBy: p("sizeBy", "cited-here"),
      colorBy: p("colorBy", "group"),
      // Ghosts off by default: a 11-paper collection expands to 500+ DOI stubs.
      showGhosts: p("showGhosts", false),
    };
  }

  scopeKey(scope) {
    return scope.kind === "collection"
      ? "c:" + scope.collection.key
      : "s:" + scope.items.map((i) => i.key).sort().join(",");
  }

  async graphForItem(item) {
    // Ego uses the item's collections if any, else just that item.
    const cids = item.getCollections?.() || [];
    let scope;
    if (cids.length) {
      const collection = Zotero.Collections.get(cids[0]);
      scope = { kind: "collection", collection };
    } else {
      scope = { kind: "selection", items: [item] };
    }
    return this.buildGraph(scope);
  }

  /** Drop a scope's graph and any build in flight, so the next call rebuilds. */
  invalidate(key) {
    this.adapterCache.delete(key);
    this.building.delete(key);
  }

  async buildGraph(scope) {
    const key = this.scopeKey(scope);
    const hit = this.adapterCache.get(key);
    if (hit && Date.now() - hit.builtAt < 5 * 60 * 1000) return hit.graph;
    // The item pane asks twice per selection (onItemChange and onRender), and
    // the graph is cached only once built: share the pass already running.
    let pending = this.building.get(key);
    if (!pending) {
      pending = this.extractGraph(scope, key)
        .then((graph) => {
          // invalidate() during the pass makes this result stale: hand it to
          // the callers already waiting, but do not cache it.
          if (this.building.get(key) === pending) {
            this.adapterCache.set(key, { graph, builtAt: Date.now() });
          }
          return graph;
        })
        .finally(() => {
          if (this.building.get(key) === pending) this.building.delete(key);
        });
      this.building.set(key, pending);
    }
    return pending;
  }

  async extractGraph(scope, key) {
    this.buildCount++;
    const t0 = Date.now();
    const timing = newTiming();
    const adapter = this.makeAdapter(scope, timing);
    // Always extract ghosts; the checkbox only filters at draw time so it can
    // flip without a rebuild.
    const graph = await CitegraphEdges.buildGraph(adapter, { includeGhosts: true });
    this.mergeCachedOpenAlex(key, graph);
    await this.pdfLinks.save();
    this.lastTiming = timing;
    log(`built ${key.slice(0, 40)} in ${Date.now() - t0} ms: ${describeTiming(timing)}`);
    return graph;
  }

  /** Fold cached OpenAlex edges in and recount honesty stats. */
  mergeCachedOpenAlex(key, graph) {
    const oa = this.loadOpenAlexCache(key);
    if (!oa?.edges?.length) return;
    const yearOf = (k) => graph.nodes.find((n) => n.id === k)?.year || null;
    const all = CitegraphEdges.merge([...graph.edges, ...oa.edges]);
    graph.edges = CitegraphEdges.resolveConflicts(all, yearOf);
    const stats = {};
    for (const e of graph.edges) {
      for (const v of e.via || []) stats[v] = (stats[v] || 0) + 1;
    }
    graph.stats = stats;
    graph.meta = { ...(graph.meta || {}), openalex: oa.edges.length };
  }

  async openGraph(scope) {
    try {
      await this._openGraph(scope);
    } catch (e) {
      log("openGraph failed: " + (e && e.stack ? e.stack : e));
      Zotero.alert(null, "Citation Graph", String(e && e.message ? e.message : e));
    }
  }

  async _openGraph(scope) {
    const win = Zotero.getMainWindows()[0];
    this.installTabHooks(win);
    this.ensureFTL(win);

    // No hyphen in type: tabs.js parseTabType() splits on '-' for the
    // '-unloaded' suffix. add() returns the container — use it, do not
    // go looking via getTabContent.
    let id;
    const { id: tabID, container } = win.Zotero_Tabs.add({
      type: "citegraph",
      title: scope.title || "Citation Graph",
      data: { title: scope.title || "Citation Graph" },
      select: true,
      onClose: () => {
        this.browsers.delete(tabID);
        this.invalidate(this.scopeKey(scope));
      },
    });
    id = tabID;

    const browser = win.document.createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("flex", "1");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("disableglobalhistory", "true");
    browser.style.minWidth = "0";
    browser.setAttribute("src", `resource://${this.resRoot}/content/graph.html`);
    container.appendChild(browser);
    this.browsers.set(tabID, browser);

    // Content defines window.citegraphSetData as it parses. Poll for it (same
    // shape as Zotero's reader _waitForReader), then push over wrappedJSObject.
    // CustomEvent chrome→content does not cross the boundary reliably.
    void this.whenReady(browser).then((cw) => {
      cw.addEventListener("citegraph-action", (e) => {
        try {
          void this.onAction(tabID, scope, JSON.parse(e.detail));
        } catch (err) {
          log("action: " + err);
        }
      });
      return this.buildGraph(scope).then((graph) => {
        this.sendTo(browser, "data", {
          graph,
          prefs: this.readPrefs(),
          meta: { version: this.version, rootURI: String(this.rootURI) },
        });
        log(`sent graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges · v${this.version} ${this.rootURI}`);
      });
    }).catch((e) => log("openGraph bridge: " + (e && e.stack ? e.stack : e)));
  }

  whenReady(browser) {
    return new Promise((resolve, reject) => {
      let n = 0;
      const tick = () => {
        const cw = browser.contentWindow;
        if (cw?.wrappedJSObject?.citegraphSetData) return resolve(cw);
        if (++n > 500) return reject(new Error("graph page never published citegraphSetData"));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  sendTo(browser, kind, payload) {
    const cw = browser.contentWindow;
    if (!cw?.wrappedJSObject?.citegraphSetData) return;
    try {
      cw.wrappedJSObject.citegraphSetData(JSON.stringify({ kind, ...payload }));
    } catch (e) {
      log("sendTo: " + e);
    }
  }

  async onAction(tabID, scope, action) {
    const browser = this.browsers.get(tabID);
    if (!browser) return;

    if (action.type === "select" && action.itemID) {
      Zotero.getActiveZoteroPane()?.selectItem(action.itemID);
      return;
    }
    if (action.type === "rebuild") {
      this.invalidate(this.scopeKey(scope));
      const graph = await this.buildGraph(scope);
      this.sendTo(browser, "data", { graph });
      return;
    }
    if (action.type === "fetch-openalex") {
      try {
        const graph = await this.buildGraph(scope);
        const doiToKey = new Map();
        // Held items only — ghost DOIs would blow the OpenAlex filter URL.
        for (const n of graph.nodes) {
          if (!n.ghost && n.doi) doiToKey.set(n.doi, n.id);
        }
        const oaToKey = (idOrDoi) => {
          const s = String(idOrDoi || "");
          if (doiToKey.has(s)) return doiToKey.get(s);
          const d = s.replace(/^https?:\/\/doi\.org\//, "");
          if (doiToKey.has(d)) return doiToKey.get(d);
          for (const [doi, key] of doiToKey) if (s.endsWith(doi)) return key;
          return null;
        };
        const dois = [...doiToKey.keys()];
        const { edges } = await CitegraphOpenAlex.fetchEdges(dois, oaToKey);
        await this.saveOpenAlexCache(this.scopeKey(scope), edges);
        // Rebuild offline + cache so via/stats stay consistent.
        this.invalidate(this.scopeKey(scope));
        const merged = await this.buildGraph(scope);
        this.sendTo(browser, "data", { graph: merged, openalex: { added: edges.length } });
      } catch (err) {
        this.sendTo(browser, "error", { error: String(err && err.message) });
      }
    }
  }

  loadOpenAlexCache(scopeKey) {
    try {
      const path = PathUtils.join(Zotero.DataDirectory.dir, "citegraph", "openalex.json");
      const file = Zotero.File.getContents(path);
      return JSON.parse(file)[scopeKey] || null;
    } catch (e) {
      return null;
    }
  }

  saveOpenAlexCache(scopeKey, edges) {
    // IOUtils.exists/makeDirectory are async — do not test exists() as a boolean.
    const dir = PathUtils.join(Zotero.DataDirectory.dir, "citegraph");
    const path = PathUtils.join(dir, "openalex.json");
    return (async () => {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      let all = {};
      try {
        all = JSON.parse(await IOUtils.readUTF8(path));
      } catch (e) {}
      all[scopeKey] = { edges, at: Date.now() };
      await IOUtils.writeUTF8(path, JSON.stringify(all));
    })();
  }

  // -- adapter -------------------------------------------------------------
  // Jajaho's ZoteroAdapter contract, slimmed to what we call.

  makeAdapter(scope, timing = newTiming()) {
    const self = this;
    const itemByKey = new Map();
    const attsByItem = new Map();
    const scopePath =
      scope.kind === "collection" && scope.collection ? collectionPath(scope.collection) : "";

    return {
      async listItems() {
        let zItems;
        if (scope.kind === "selection") {
          zItems = scope.items.slice();
        } else {
          const c = scope.collection;
          await c.loadDataType("childItems").catch(() => {});
          zItems = c.getChildItems(false, false);
          // subcollections
          try {
            for (const d of c.getDescendents(false, "collection")) {
              const sub = Zotero.Collections.get(d.id);
              await sub.loadDataType("childItems").catch(() => {});
              zItems = zItems.concat(sub.getChildItems(false, false));
            }
          } catch (e) {}
        }
        await Zotero.Items.loadDataTypes(zItems);
        const out = [];
        for (const item of zItems) {
          if (!item.isRegularItem() || item.deleted) continue;
          const title = field(item, "title", { baseMapped: true });
          if (!title) continue;
          // Full "Parent/Sub" paths so two "Methods" under different parents
          // stay distinct; primaryCollection picks the color key.
          const paths = (item.getCollections() || [])
            .map((id) => {
              const c = Zotero.Collections.get(id);
              return c ? collectionPath(c) : null;
            })
            .filter(Boolean);
          const rec = {
            key: item.key,
            itemID: item.id,
            title,
            doi: field(item, "DOI") || null,
            date: field(item, "date", { unformatted: true }) || null,
            extra: field(item, "extra") || null,
            year: firstYear(field(item, "date", { unformatted: true })),
            creators: (item.getCreators() || []).map((c) => c.lastName || c.name || ""),
            venue: field(item, "publicationTitle") || field(item, "bookTitle") || "",
            collections: paths,
            collection: CitegraphEdges.primaryCollection(paths, scopePath),
            hasPdf: item
              .getAttachments()
              .some((id) => Zotero.Items.get(id)?.attachmentContentType === "application/pdf"),
            notes: item
              .getNotes()
              .map((id) => {
                try {
                  return Zotero.Items.get(id)?.getNote?.() || "";
                } catch (e) {
                  return "";
                }
              })
              .filter(Boolean),
          };
          itemByKey.set(item.key, item);
          out.push(rec);
        }
        return out;
      },

      async getAttachments(itemKey) {
        if (attsByItem.has(itemKey)) return attsByItem.get(itemKey);
        const out = [];
        const item = itemByKey.get(itemKey);
        if (item) {
          const atts = await Zotero.Items.getAsync(item.getAttachments());
          await Zotero.Items.loadDataTypes(atts);
          for (const att of atts) {
            if (att.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) continue;
            const file = await att.getFilePathAsync();
            if (!file) continue;
            out.push({
              key: att.key,
              parentKey: itemKey,
              contentType: att.attachmentContentType || "",
              file,
              _att: att,
            });
          }
        }
        attsByItem.set(itemKey, out);
        return out;
      },

      async getAttachmentText(attKey) {
        const atts = [...attsByItem.values()].flat();
        const rec = atts.find((a) => a.key === attKey);
        if (!rec) return null;
        const path = ftCachePath(rec._att);
        if (!path) return null;
        const t = Date.now();
        try {
          if (!(await IOUtils.exists(path))) return null;
          return await Zotero.File.getContentsAsync(path, "utf-8");
        } catch (e) {
          return null;
        } finally {
          timing.texts++;
          timing.textReadMs += Date.now() - t;
        }
      },

      async getPdfLinkUris(attKey) {
        const atts = [...attsByItem.values()].flat();
        const rec = atts.find((a) => a.key === attKey);
        if (!rec || rec.contentType !== "application/pdf") return [];
        try {
          // A PDF's links change only with the file, so scan each version once.
          const { size, lastModified } = await IOUtils.stat(rec.file);
          const id = `${rec._att.libraryID}/${attKey}`;
          const saved = await self.pdfLinks.get(id, size, lastModified);
          if (saved) {
            timing.pdfCached++;
            return saved;
          }
          const t = Date.now();
          const bytes = await IOUtils.read(rec.file);
          const t1 = Date.now();
          timing.pdfs++;
          timing.pdfBytes += bytes.length;
          timing.pdfReadMs += t1 - t;
          const uris = await self.scanner.scan(bytes, rec.file);
          const scan = Date.now() - t1;
          timing.pdfScanMs += scan;
          timing.pdfScanMaxMs = Math.max(timing.pdfScanMaxMs, scan);
          self.pdfLinks.set(id, size, lastModified, uris);
          return uris;
        } catch (e) {
          return [];
        }
      },
    };
  }
}

// -- shared helpers (Jajaho-slim) ------------------------------------------

/**
 * Scans PDF bytes in a worker. If the worker cannot start, scans on the main
 * thread as before, so the graph still builds.
 */
class PdfScanner {
  constructor(url) {
    this.url = url;
    this.worker = null;
    this.failed = false;
    this.lastID = 0;
    this.waiting = new Map(); // id -> {resolve, file}
  }

  get mode() {
    return this.failed ? "main thread" : "worker";
  }

  start() {
    if (this.worker || this.failed) return this.worker;
    try {
      const W =
        (typeof ChromeWorker !== "undefined" && ChromeWorker) ||
        (typeof Worker !== "undefined" && Worker) ||
        Zotero.getMainWindow()?.ChromeWorker;
      this.worker = new W(this.url);
      this.worker.onmessage = (e) => this.onReply(e.data);
      this.worker.onerror = (e) => this.onFailure(e?.message || "worker error");
    } catch (e) {
      this.onFailure(String(e));
    }
    return this.worker;
  }

  /** URIs found in `bytes`; the bytes are handed to the worker, not copied. */
  scan(bytes, file) {
    const worker = this.start();
    if (!worker) return Promise.resolve(scanOnMainThread(bytes));
    const id = ++this.lastID;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve, file });
      worker.postMessage({ id, bytes }, [bytes.buffer]);
    });
  }

  onReply({ id, uris, error }) {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    if (error) log(`scan ${w.file}: ${error}`);
    w.resolve(uris || []);
  }

  onFailure(msg) {
    log(`scan worker failed, scanning on the main thread: ${msg}`);
    this.failed = true;
    this.worker?.terminate();
    this.worker = null;
    // Their bytes went to the worker: read the files again.
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of waiting) {
      IOUtils.read(w.file)
        .then((bytes) => w.resolve(scanOnMainThread(bytes)))
        .catch(() => w.resolve([]));
    }
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.resolve([]);
    this.waiting.clear();
  }
}

/**
 * Each PDF's link URIs, keyed "libraryID/attachmentKey" and valid while the
 * file keeps its size and mtime. Saved to citegraph/pdf-links.json in the
 * data directory so a restart does not rescan every PDF.
 */
class PdfLinkCache {
  constructor() {
    this.entries = new Map(); // id -> {size, mtime, uris}
    this.loading = null;
    this.dirty = false;
    this.saving = Promise.resolve();
  }

  get path() {
    return PathUtils.join(Zotero.DataDirectory.dir, "citegraph", "pdf-links.json");
  }

  load() {
    this.loading ||= (async () => {
      try {
        const data = JSON.parse(await IOUtils.readUTF8(this.path));
        if (data?.version !== 1) return;
        for (const [id, e] of Object.entries(data.pdfs || {})) this.entries.set(id, e);
      } catch (e) {
        // Missing or unreadable: every PDF is scanned again.
      }
    })();
    return this.loading;
  }

  /** The saved URIs, or null when the PDF is new or has changed. */
  async get(id, size, mtime) {
    await this.load();
    const e = this.entries.get(id);
    return e && e.size === size && e.mtime === mtime ? e.uris : null;
  }

  set(id, size, mtime, uris) {
    this.entries.set(id, { size, mtime, uris });
    this.dirty = true;
  }

  /** Write the file if anything was scanned, dropping deleted attachments. */
  save() {
    if (!this.dirty) return this.saving;
    this.dirty = false;
    this.saving = this.saving
      .then(async () => {
        for (const id of [...this.entries.keys()]) {
          const [lib, key] = id.split("/");
          if (!Zotero.Items.getByLibraryAndKey(Number(lib), key)) this.entries.delete(id);
        }
        const json = JSON.stringify({ version: 1, pdfs: Object.fromEntries(this.entries) });
        await IOUtils.makeDirectory(PathUtils.parent(this.path), { ignoreExisting: true });
        await IOUtils.writeUTF8(this.path, json, { tmpPath: this.path + ".tmp" });
      })
      .catch((e) => log("saving pdf-links.json: " + e));
    return this.saving;
  }

  /** Forget the in-memory copy; the next get() reads the file again. */
  clear() {
    this.entries.clear();
    this.loading = null;
    this.dirty = false;
  }

  /** Forget everything, file included (live suite: a truly cold build). */
  async reset() {
    await this.saving;
    this.clear();
    await IOUtils.remove(this.path, { ignoreAbsent: true });
  }
}

function scanOnMainThread(bytes) {
  return CitegraphPdfScan.scanUriAnnotations(bytes, inflater());
}

function newTiming() {
  return {
    pdfCached: 0,
    pdfs: 0,
    pdfBytes: 0,
    pdfReadMs: 0,
    pdfScanMs: 0,
    pdfScanMaxMs: 0,
    texts: 0,
    textReadMs: 0,
  };
}

function describeTiming(t) {
  const mb = (t.pdfBytes / 1048576).toFixed(1);
  return (
    `${t.pdfCached} PDFs unchanged; ${t.pdfs} PDFs (${mb} MB) read ${t.pdfReadMs} ms, ` +
    `scanned ${t.pdfScanMs} ms (max ${t.pdfScanMaxMs} ms); ` +
    `${t.texts} texts read ${t.textReadMs} ms`
  );
}

function log(msg) {
  Zotero.debug(`Citation Graph: ${msg}`);
}

function field(item, name, opts) {
  try {
    return item.getField(name, opts?.unformatted, opts?.baseMapped) || "";
  } catch (e) {
    return "";
  }
}

function firstYear(s) {
  const m = String(s || "").match(/\b(1[89]\d\d|20\d\d)\b/);
  return m ? Number(m[1]) : null;
}

/** "Parent/Sub/Leaf" via parent IDs. Names, not keys — legend-readable. */
function collectionPath(col) {
  const names = [];
  let c = col;
  for (let i = 0; c && i < 30; i++) {
    names.unshift(String(c.name || "?"));
    // .parent is deprecated (warns and returns parentID). Use parentID.
    c = c.parentID ? Zotero.Collections.get(c.parentID) : null;
  }
  return names.join("/");
}

function shortAuthor(n) {
  const a = n.creators && n.creators[0];
  return a || n.title.slice(0, 12);
}

function ftCachePath(att) {
  const FT = Zotero.FullText || Zotero.Fulltext;
  try {
    const f = FT?.getItemCacheFile?.(att);
    if (f?.path) return f.path;
  } catch (e) {}
  try {
    return PathUtils.join(Zotero.Attachments.getStorageDirectory(att).path, ".zotero-ft-cache");
  } catch (e) {
    return null;
  }
}

let _pako;
function inflater() {
  if (_pako === undefined) {
    try {
      const scope = { exports: {}, module: {} };
      Services.scriptloader.loadSubScript("resource://zotero/pako.js", scope);
      _pako = typeof scope.exports.inflate === "function" ? scope.exports : false;
    } catch (e) {
      _pako = false;
    }
  }
  return _pako ? (b) => _pako.inflate(b) : null;
}

