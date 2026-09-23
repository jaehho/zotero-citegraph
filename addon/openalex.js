/* OpenAlex citation fetch. Explicit action only — never automatic. */
"use strict";

var CitegraphOpenAlex = (function () {
  const API = "https://api.openalex.org/works";

  /**
   * Emit edges among held items from OpenAlex reference lists.
   * Two passes: index every work first, then walk reference lists (a reference
   * can point at an item in a later batch).
   * @param {string[]} dois  held-item DOIs (normalized)
   * @param {(idOrDoi: string) => ?string} toKey  → item key
   */
  async function fetchEdges(dois, toKey, mailto) {
    const idToKey = new Map();
    const works = [];
    let unresolved = 0;

    for (let i = 0; i < dois.length; i += 15) {
      const batch = dois.slice(i, i + 15).filter((d) => /^10\.\d{4,9}\//.test(d));
      if (!batch.length) continue;
      // OpenAlex: field name once, values pipe-separated. `doi:a|doi:b` is a 400.
      const filter = "doi:" + batch.join("|");
      const url =
        `${API}?filter=${encodeURIComponent(filter)}` +
        `&select=id,doi,referenced_works&per-page=25` +
        (mailto ? `&mailto=${encodeURIComponent(mailto)}` : "");
      let json;
      try {
        json = await getJson(url);
      } catch (e) {
        unresolved += batch.length;
        continue;
      }
      for (const w of json.results || []) {
        works.push(w);
        const doi = String(w.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
        const from = toKey(doi) || toKey(w.id);
        if (from && w.id) idToKey.set(w.id, from);
        else unresolved++;
      }
    }

    const edges = [];
    for (const w of works) {
      const doi = String(w.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
      const from = toKey(doi) || toKey(w.id);
      if (!from) continue;
      for (const ref of w.referenced_works || []) {
        const to = idToKey.get(ref) || toKey(ref);
        if (to && to !== from) {
          edges.push({
            from,
            to,
            via: "openalex",
            confidence: 0.98,
            evidence: { openalexId: ref },
          });
        }
      }
    }
    return { edges, unresolved };
  }

  async function getJson(url) {
    if (typeof Zotero !== "undefined" && Zotero.HTTP) {
      const xhr = await Zotero.HTTP.request("GET", url, { responseType: "json" });
      return xhr.response;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  return { fetchEdges };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = CitegraphOpenAlex;
}
