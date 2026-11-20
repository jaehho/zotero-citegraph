/* Runs CitegraphPdfScan off Zotero's main thread (#16): a large PDF takes
 * hundreds of ms to scan, and the main thread handles every click and menu.
 */
"use strict";

importScripts("resource://zotero/pako.js", "resource://citegraph/pdfscan.js");

/* global pako, CitegraphPdfScan */
const inflate = typeof pako !== "undefined" && pako.inflate ? (b) => pako.inflate(b) : null;

onmessage = (e) => {
  const { id, bytes } = e.data;
  try {
    postMessage({ id, uris: CitegraphPdfScan.scanUriAnnotations(bytes, inflate) });
  } catch (err) {
    postMessage({ id, uris: [], error: String(err) });
  }
};
