/* Citation Graph for Zotero. */

var Citegraph;
var resProto;

function install() {}
function uninstall() {}

function log(msg) {
  Zotero.debug(`Citation Graph: ${msg}`);
}

async function startup({ id, version, rootURI }, reason) {
  // Serve content over resource://citegraph/ (same as Zotero's own reader pages).
  // chrome:// via registerChrome also works, but the returned handle must be
  // retained or the package silently unregisters.
  resProto = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  resProto.setSubstitution("citegraph", Services.io.newURI(rootURI));

  Services.scriptloader.loadSubScript(rootURI + "edges.js");
  Services.scriptloader.loadSubScript(rootURI + "openalex.js");
  Services.scriptloader.loadSubScript(rootURI + "ui.js");

  Citegraph = new CitegraphUI({ rootURI, id, version, resRoot: "citegraph" });
  await Citegraph.startup(reason);

  // make check only. One-shot: consume the pref immediately so a stale
  // `true` can never auto-open a graph on install or every launch.
  try {
    if (Zotero.Prefs.get("extensions.zotero-citegraph.selftest", true)) {
      Zotero.Prefs.set("extensions.zotero-citegraph.selftest", false);
      Services.scriptloader.loadSubScript(rootURI + "selftest.js");
      setTimeout(() => {
        void CitegraphSelfTest.run(Citegraph).catch((e) => log("selftest: " + e));
      }, 1500);
    }
  } catch (e) {
    log("selftest gate: " + e);
  }
}

function shutdown() {
  Citegraph?.shutdown();
  Citegraph = null;
  try {
    resProto?.setSubstitution("citegraph", null);
  } catch (e) {}
  resProto = null;
}

function onMainWindowLoad({ window }) {
  Citegraph?.attach(window);
}

function onMainWindowUnload({ window }) {
  Citegraph?.detach(window);
}
