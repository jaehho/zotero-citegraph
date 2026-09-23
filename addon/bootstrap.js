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
  Services.scriptloader.loadSubScript(rootURI + "selftest.js");

  Citegraph = new CitegraphUI({ rootURI, id, version, resRoot: "citegraph" });
  await Citegraph.startup(reason);

  // Live suite (make check): pref extensions.zotero-citegraph.selftest
  if (CitegraphSelfTest.wanted()) {
    // give main window a beat to attach menus
    setTimeout(() => {
      void CitegraphSelfTest.run(Citegraph).catch((e) => log("selftest: " + e));
    }, 1500);
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
