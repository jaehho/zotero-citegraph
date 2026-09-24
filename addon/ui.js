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
    body.textContent = "";
    if (!item?.isRegularItem?.()) {
      setEnabled?.(false);
      return;
    }
    setEnabled?.(true);
    const graph = await this.graphForItem(item);
    const buildsOn = graph.edges.filter((e) => e.from === item.key);
    const builtOnBy = graph.edges.filter((e) => e.to === item.key);
    setSectionSummary?.(`${buildsOn.length} ← → ${builtOnBy.length}`);

    const doc = body.ownerDocument;
    const row = (label, list) => {
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
        const other = graph.nodes.find((n) => n.id === (label === "Builds on" ? e.to : e.from));
        if (!other || other.ghost) continue;
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
    body.appendChild(row("Builds on", buildsOn));
    body.appendChild(row("Built on by", builtOnBy));
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
      colorBy: p("colorBy", "year"),
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

  async buildGraph(scope) {
    const key = this.scopeKey(scope);
    const hit = this.adapterCache.get(key);
    if (hit && Date.now() - hit.builtAt < 5 * 60 * 1000) return hit.graph;

    const adapter = this.makeAdapter(scope);
    // Always extract ghosts; the checkbox only filters at draw time so it can
    // flip without a rebuild.
    const graph = await CitegraphEdges.buildGraph(adapter, { includeGhosts: true });
    this.mergeCachedOpenAlex(key, graph);
    this.adapterCache.set(key, { graph, builtAt: Date.now() });
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
        this.adapterCache.delete(this.scopeKey(scope));
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
      this.adapterCache.delete(this.scopeKey(scope));
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
        this.adapterCache.delete(this.scopeKey(scope));
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

  makeAdapter(scope) {
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
        try {
          if (!(await IOUtils.exists(path))) return null;
          return await Zotero.File.getContentsAsync(path, "utf-8");
        } catch (e) {
          return null;
        }
      },

      async getPdfLinkUris(attKey) {
        const atts = [...attsByItem.values()].flat();
        const rec = atts.find((a) => a.key === attKey);
        if (!rec || rec.contentType !== "application/pdf") return [];
        try {
          const bytes = await IOUtils.read(rec.file);
          return scanUriAnnotations(bytes, inflater());
        } catch (e) {
          return [];
        }
      },
    };
  }
}

// -- shared helpers (Jajaho-slim) ------------------------------------------

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

const URI_RE = /\/URI\s*\(((?:[^()\\]|\\[\s\S])*)\)/g;
const STREAM_RE = /(?<!end)stream\r?\n/g;
const LENGTH_RE = /\/Length\s+(\d+)(?![\d\s]*R)/;

function scanUriAnnotations(bytes, inflate) {
  const s = bytesToBinaryString(bytes);
  const uris = new Set();
  collectUris(s, uris);
  if (!inflate) return [...uris];
  STREAM_RE.lastIndex = 0;
  let m;
  while ((m = STREAM_RE.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    STREAM_RE.lastIndex = end;
    const head = s.slice(Math.max(0, m.index - 1024), m.index);
    const at = head.lastIndexOf("obj");
    if (at < 0) continue;
    const dict = head.slice(at);
    if (!dict.includes("/ObjStm") || !dict.includes("/FlateDecode")) continue;
    const len = LENGTH_RE.exec(dict);
    let stop = len && start + Number(len[1]) <= end ? start + Number(len[1]) : end;
    if (stop === end) {
      while (stop > start && (s[stop - 1] === "\n" || s[stop - 1] === "\r")) stop--;
    }
    try {
      collectUris(bytesToBinaryString(inflate(bytes.subarray(start, stop))), uris);
    } catch (e) {}
  }
  return [...uris];
}

function collectUris(s, uris) {
  URI_RE.lastIndex = 0;
  let m;
  while ((m = URI_RE.exec(s))) uris.add(m[1].replace(/\\([()\\])/g, "$1"));
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

function bytesToBinaryString(bytes) {
  const CHUNK = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return parts.join("");
}
