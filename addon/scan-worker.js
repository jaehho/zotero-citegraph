/* Runs Citegraph's per-file work off Zotero's main thread (#16): a large PDF
 * takes hundreds of ms to scan, a full text tens of ms to search, and the main
 * thread handles every click and menu.
 *
 * Messages: {kind: "titles", titlesID, titles} sets a build's titles;
 * {id, kind: "pdf", bytes} and {id, kind: "text", bytes, titlesID} reply
 * {id, result} or {id, error}.
 */
"use strict";

importScripts(
  "resource://zotero/pako.js",
  "resource://citegraph/pdfscan.js",
  "resource://citegraph/edges.js",
);

/* global pako, CitegraphPdfScan, CitegraphEdges */
const inflate = typeof pako !== "undefined" && pako.inflate ? (b) => pako.inflate(b) : null;
const decoder = new TextDecoder();
const titleIndexes = new Map(); // titlesID -> titleIndex, last few builds

onmessage = (e) => {
  const msg = e.data;
  if (msg.kind === "titles") {
    titleIndexes.set(msg.titlesID, CitegraphEdges.titleIndex(msg.titles));
    for (const id of titleIndexes.keys()) if (titleIndexes.size > 4) titleIndexes.delete(id);
    return;
  }
  try {
    postMessage({ id: msg.id, result: work(msg) });
  } catch (err) {
    postMessage({ id: msg.id, error: String(err) });
  }
};

function work(msg) {
  if (msg.kind === "text") {
    const index = titleIndexes.get(msg.titlesID);
    if (!index) throw new Error(`no titles ${msg.titlesID}`);
    return CitegraphEdges.analyzeText(decoder.decode(msg.bytes), index);
  }
  return CitegraphPdfScan.scanUriAnnotations(msg.bytes, inflate);
}
