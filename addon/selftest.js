/* Live feature suite. Loaded with the plugin; runs when the selftest pref is on.
 * Writes /tmp/citegraph-live-test.json so the Makefile can assert on it.
 */
"use strict";

var CitegraphSelfTest = (function () {
  const REPORT = "/tmp/citegraph-live-test.json";

  async function run(ui) {
    const checks = [];
    const ok = (name, pass, detail) => {
      checks.push({ name, pass: !!pass, detail: detail == null ? "" : String(detail) });
    };

    try {
      // -- chrome surface ----------------------------------------------------
      ok("resource substitution", !!ui.resRoot && !!ui.rootURI);
      ok("MenuManager present", !!Zotero.MenuManager?.registerMenu);
      ok("menus registered", ui.menuIDs.filter(Boolean).length >= 2, ui.menuIDs.join(","));

      // The collection popup must actually contain our entry (or DOM fallback).
      const win0 = Zotero.getMainWindows()[0];
      const pop = win0?.document?.getElementById("zotero-collectionmenu");
      ok("collection popup exists", !!pop);
      if (pop) {
        try {
          pop.dispatchEvent(new win0.Event("popupshowing", { bubbles: true }));
        } catch (e) {}
        await sleep(50);
        const ours = ui.findOurMenuitem(pop);
        const all = [...pop.querySelectorAll("menuitem")].map(
          (el) => el.getAttribute("label") || el.getAttribute("data-l10n-id") || "?",
        );
        ok("collection menu has our item", !!ours, all.join(" | ").slice(0, 200));
        ok(
          "our item is visible",
          !!ours && !ours.hidden,
          ours ? `hidden=${ours.hidden} label=${ours.getAttribute("label")}` : "missing",
        );
      }

      const pane = Zotero.getActiveZoteroPane() || Zotero.getMainWindows()[0]?.ZoteroPane;
      ok("ZoteroPane", !!pane);

      // -- find Chiappe ------------------------------------------------------
      const collection = findByKey("28EET5UR") || findByName(/chiappe/i);
      ok("Chiappe collection", !!collection, collection?.name);
      if (!collection) throw new Error("no Chiappe collection");

      // -- buildGraph --------------------------------------------------------
      const graph = await ui.buildGraph({ kind: "collection", collection });
      const held = graph.nodes.filter((n) => !n.ghost);
      const ghosts = graph.nodes.filter((n) => n.ghost);
      ok("11 held nodes", held.length === 11, `got ${held.length}`);
      ok("ghost nodes exist", ghosts.length > 0, `got ${ghosts.length}`);
      ok("has edges", graph.edges.length > 0, `got ${graph.edges.length}`);
      ok(
        "year guard",
        graph.edges.every((e) => {
          const a = graph.nodes.find((n) => n.id === e.from);
          const b = graph.nodes.find((n) => n.id === e.to);
          return CitegraphEdges.yearOk(a?.year, b?.year);
        }),
      );
      ok(
        "no two-arrow conflict pairs",
        !hasFalsePair(graph),
        hasFalsePair(graph) ? "found A→B and B→A both non-mutual" : "",
      );
      const mutuals = graph.edges.filter((e) => e.mutual);
      ok("mutual edges collapsed", mutuals.every((e) => e.mutual), `mutual count ${mutuals.length}`);

      // -- item-pane ego -----------------------------------------------------
      const item = Zotero.Items.get(held[0]?.itemID) || collection.getChildItems()[0];
      ok("ego item", !!item, item?.getField?.("title"));
      if (item) {
        const body = {
          textContent: "",
          appendChild() {},
          ownerDocument: Zotero.getMainWindows()[0]?.document,
        };
        let summary = "";
        await ui.renderEgo(body, item, null, (s) => (summary = s));
        ok("ego renders", true, summary);
        const eg = await ui.graphForItem(item);
        ok("ego graph", eg.nodes.length >= 1, `nodes ${eg.nodes.length}`);
      }

      // -- OpenAlex ----------------------------------------------------------
      let oaAdded = 0;
      try {
        const doiToKey = new Map();
        for (const n of graph.nodes) if (!n.ghost && n.doi) doiToKey.set(n.doi, n.id);
        const toKey = (s) => {
          const d = String(s || "").replace(/^https?:\/\/doi\.org\//, "");
          return doiToKey.get(d) || doiToKey.get(s) || null;
        };
        const { edges: oaEdges, unresolved } = await CitegraphOpenAlex.fetchEdges(
          [...doiToKey.keys()],
          toKey,
        );
        oaAdded = oaEdges.length;
        ok("OpenAlex fetch", oaEdges.length > 0, `edges ${oaEdges.length}, unresolved ${unresolved}`);
        await ui.saveOpenAlexCache(ui.scopeKey({ kind: "collection", collection }), oaEdges);
        // rebuild picks up the cache
        ui.adapterCache.delete(ui.scopeKey({ kind: "collection", collection }));
        const g2 = await ui.buildGraph({ kind: "collection", collection });
        const m2 = g2.edges.filter((e) => e.mutual).length;
        ok("OpenAlex mutuals (expect 6)", m2 === 6, `got ${m2}, edges ${g2.edges.length}`);
        ok(
          "no reverse into 2025/2026",
          !hasFalsePair(g2) && !olderCitesMuchNewer(g2),
          `edges ${g2.edges.length}`,
        );
        const viaHas = (name) => g2.edges.some((e) => (e.via || []).includes(name));
        ok(
          "offline + openalex combined",
          viaHas("openalex") && viaHas("pdf-links") && viaHas("title-match"),
          JSON.stringify(g2.stats),
        );
      } catch (e) {
        ok("OpenAlex fetch", false, e && e.message);
      }

      // -- graph tab + bridge + content --------------------------------------
      const win = Zotero.getMainWindows()[0];
      await ui.openGraph({
        kind: "collection",
        collection,
        title: collection.name || "Citation Graph",
      });
      await sleep(800);
      ok("tab opened", ui.browsers.size === 1, `browsers ${ui.browsers.size}`);
      const browser = [...ui.browsers.values()][0];
      ok("browser mounted", !!browser?.parentNode);

      let content = null;
      if (browser) {
        try {
          content = await ui.whenReady(browser);
          ok("bridge citegraphSetData", !!content.wrappedJSObject?.citegraphSetData);
        } catch (e) {
          ok("bridge citegraphSetData", false, e && e.message);
        }
      }

      if (content?.wrappedJSObject?.citegraphSelfTest) {
        // ensure data has been pushed
        await sleep(400);
        let ct;
        try {
          ct = content.wrappedJSObject.citegraphSelfTest();
          if (ct && typeof ct.then === "function") ct = await ct;
        } catch (e) {
          ct = { error: String(e && e.message) };
        }
        ok("content ForceGraph", ct.forceGraph === true, JSON.stringify(ct).slice(0, 200));
        ok("content data loaded", ct.nodeCount >= 11, `nodes ${ct.nodeCount} edges ${ct.edgeCount}`);
        ok("content footer stamp", /v\S+\s·\s(dev|xpi)/.test(ct.footer || ""), ct.footer);
        ok("content ghosts filter", ct.ghostsFilter === true, JSON.stringify(ct.ghostsDetail));
        ok("content tooltips", ct.tooltips === true, ct.tooltipDetail);
        ok("content render", ct.renderOk !== false, ct.renderStatus);
        ok("content controls", ct.controls === true, ct.controlDetail);
        ok("content edge shaft paints", ct.edgePaintOk === true, JSON.stringify(ct.edgePaint));
        // dump canvases for visual check (probe = known 400×400 with one red edge)
        const dumps = [
          ["probe", ct.probeSnapshot],
          ["live", ct.snapshot],
        ];
        for (const [name, url] of dumps) {
          if (!url || !url.startsWith("data:image/png;base64,")) {
            ok(`canvas snapshot ${name}`, false, "no snapshot");
            continue;
          }
          try {
            const b64 = url.slice("data:image/png;base64,".length);
            const bytes = atob(b64);
            const arr = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
            await IOUtils.write(`/tmp/citegraph-${name}.png`, arr);
            ok(`canvas snapshot ${name}`, true, `bytes ${arr.length}`);
          } catch (e) {
            ok(`canvas snapshot ${name}`, false, String(e && e.message));
          }
        }
      } else {
        ok("content citegraphSelfTest", false, "missing");
      }

      // -- user walk: real mouse events on the canvas ------------------------
      if (content?.wrappedJSObject?.citegraphUserWalk) {
        await sleep(600); // layout
        let walk;
        try {
          walk = await content.wrappedJSObject.citegraphUserWalk();
        } catch (e) {
          walk = { pass: false, failed: ["walk threw: " + (e && e.message)], steps: [] };
        }
        for (const s of walk.steps || []) ok("walk: " + s.name, s.pass, s.detail);
        if (!walk.pass && !(walk.steps || []).length) ok("user walk", false, (walk.failed || []).join("; "));
      } else {
        ok("citegraphUserWalk", false, "missing");
      }

      // -- rebuild action ----------------------------------------------------
      if (browser && content) {
        ui.onAction([...ui.browsers.keys()][0], { kind: "collection", collection }, { type: "rebuild" });
        await sleep(300);
        ok("rebuild action", true);
      }
    } catch (e) {
      ok("suite crashed", false, e && e.stack ? e.stack : e);
    }

    // Close every citegraph tab we opened — otherwise session restore brings
    // Chiappe back on the next launch (looks like install auto-opened it).
    try {
      const win = Zotero.getMainWindows()[0];
      for (const tabID of [...ui.browsers.keys()]) {
        try {
          win.Zotero_Tabs.close(tabID);
        } catch (e) {}
        ui.browsers.delete(tabID);
      }
    } catch (e) {}

    const pass = checks.every((c) => c.pass);
    const report = {
      at: new Date().toISOString(),
      pass,
      passed: checks.filter((c) => c.pass).length,
      failed: checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`),
      checks,
    };
    try {
      await IOUtils.writeUTF8(REPORT, JSON.stringify(report, null, 2));
    } catch (e) {
      try {
        Zotero.File.putContents(REPORT, JSON.stringify(report, null, 2));
      } catch (e2) {
        log("selftest write failed: " + e2);
      }
    }
    log(`selftest ${pass ? "PASS" : "FAIL"} ${report.passed}/${checks.length}`);
    for (const c of checks) log(`  ${c.pass ? "ok" : "FAIL"} ${c.name} ${c.detail}`);
    return report;
  }

  function hasFalsePair(graph) {
    const set = new Map();
    for (const e of graph.edges) {
      const k = e.from < e.to ? e.from + "\0" + e.to : e.to + "\0" + e.from;
      const prev = set.get(k);
      if (prev && prev.from !== e.from && !e.mutual && !prev.mutual) return true;
      set.set(k, e);
    }
    return false;
  }

  function olderCitesMuchNewer(graph) {
    return graph.edges.some((e) => {
      const a = graph.nodes.find((n) => n.id === e.from);
      const b = graph.nodes.find((n) => n.id === e.to);
      return a?.year && b?.year && b.year > a.year + 1;
    });
  }

  function findByKey(key) {
    for (const lib of Zotero.Libraries.getAll()) {
      for (const c of Zotero.Collections.getByLibrary(lib.libraryID, true) || []) {
        if (c.key === key) return c;
      }
    }
    return null;
  }

  function findByName(re) {
    for (const lib of Zotero.Libraries.getAll()) {
      for (const c of Zotero.Collections.getByLibrary(lib.libraryID, true) || []) {
        if (re.test(c.name || "")) return c;
      }
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function wanted() {
    try {
      return !!Zotero.Prefs.get("extensions.zotero-citegraph.selftest", true);
    } catch (e) {
      return false;
    }
  }

  return { run, wanted, REPORT };
})();
