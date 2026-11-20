/* Finds link-annotation URIs in PDF bytes, including those packed in
 * compressed object streams. Pure JS: loaded in Zotero chrome, in the scan
 * worker (importScripts) and in node --test.
 */
"use strict";

var CitegraphPdfScan = (function () {
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

  function bytesToBinaryString(bytes) {
    const CHUNK = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return parts.join("");
  }

  return { scanUriAnnotations };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = CitegraphPdfScan;
}
