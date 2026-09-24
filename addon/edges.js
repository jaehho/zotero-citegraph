/* Citation edge extraction. Pure JS — loaded in Zotero chrome and in node --test.
 *
 * A → B means A cites B. One edge per ordered pair. Conflicts and mutual cites
 * are resolved in resolveConflicts so the graph never draws two arrows that
 * merely mean "two matchers disagreed".
 */
"use strict";

var CitegraphEdges = (function () {
  // -- normalize -----------------------------------------------------------

  const DOI_RE = /10\.\d{4,9}\/[-._;()\/:<>a-zA-Z0-9]+/;
  const DOI_RE_G = new RegExp(DOI_RE.source, "g");
  const URL_TAIL_RE = /\/(abstract|epdf|full|pdf|meta|html|summary)$/;

  function decodePercentEscapes(s) {
    return String(s).replace(/%[0-9A-Fa-f]{2}/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch (_) {
        return m;
      }
    });
  }

  function stripUnmatchedCloser(d) {
    let s = d;
    for (;;) {
      if (!s.endsWith(")")) return s;
      const open = (s.match(/\(/g) || []).length;
      const close = (s.match(/\)/g) || []).length;
      if (close <= open) return s;
      s = s.slice(0, -1).replace(/[.,;:\]]+$/, "");
    }
  }

  function normDoi(raw) {
    if (!raw) return null;
    let d = decodePercentEscapes(String(raw).trim())
      .toLowerCase()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
      .replace(/^doi:\s*/, "")
      .replace(/[.,;:\]]+$/, "")
      .replace(URL_TAIL_RE, "");
    d = stripUnmatchedCloser(d);
    return /^10\.\d{4,9}\//.test(d) ? d : null;
  }

  function findDois(text) {
    if (!text) return [];
    const prepared = decodePercentEscapes(text).replace(/-\r?\n\s*/g, "");
    const out = new Set();
    for (const m of prepared.match(DOI_RE_G) || []) {
      const d = normDoi(m);
      if (d && /\d/.test(d.slice(d.indexOf("/") + 1))) out.add(d);
    }
    return [...out];
  }

  function normTitle(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function flattenPdfText(s) {
    return String(s || "")
      .replace(/-\r?\n\s*/g, "")
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ");
  }

  function firstYear(s) {
    const m = String(s || "").match(/\b(1[89]\d\d|20\d\d)\b/);
    return m ? Number(m[1]) : null;
  }

  // -- reference section ---------------------------------------------------

  const HEADING =
    /^\s*(\d+\.?\s*)?(references|bibliography|literature cited|works cited|references and notes|reference list)\s*:?\s*$/i;
  const NUMBERED = /^\s*[\[(]?(\d{1,3})[\]).]\s+\S/;

  /** @returns {{text, flat, quality: 'heading'|'numbered'|'tail'|'none'}} */
  function segment(text, opts) {
    const tailFraction = (opts && opts.tailFraction) || 0.4;
    const minNumberedRun = (opts && opts.minNumberedRun) || 5;
    if (!text || text.length < 200) return { text: "", flat: "", quality: "none" };
    const lines = text.split(/\r?\n/);

    for (let i = lines.length - 1; i >= 0; i--) {
      if (HEADING.test(lines[i])) {
        const t = lines.slice(i + 1).join("\n");
        if (t.trim().length > 100) return finish(t, "heading");
      }
    }

    const marks = [];
    for (let i = 0; i < lines.length; i++) {
      const m = NUMBERED.exec(lines[i]);
      if (m) marks.push({ line: i, n: Number(m[1]) });
    }
    const chains = [];
    for (const mark of marks) {
      const last = chains.length ? chains[chains.length - 1] : null;
      const prev = last && last[last.length - 1];
      if (prev && mark.n > prev.n && mark.n - prev.n <= 3 && mark.line - prev.line <= 40) {
        last.push(mark);
      } else {
        chains.push([mark]);
      }
    }
    let bestStart = -1;
    for (let i = chains.length - 1; i >= 0; i--) {
      if (chains[i].length < minNumberedRun) continue;
      bestStart = chains[i][0].line;
      break;
    }
    if (bestStart > 0 && bestStart < lines.length * (1 - tailFraction / 2)) {
      return finish(lines.slice(bestStart).join("\n"), "numbered");
    }

    const cut = Math.floor(lines.length * (1 - tailFraction));
    return finish(lines.slice(cut).join("\n"), "tail");

    function finish(t, quality) {
      return { text: t, flat: flattenPdfText(t), quality };
    }
  }

  // -- edge model ----------------------------------------------------------

  const STRATEGY_RANK = {
    openalex: 6,
    "pdf-links": 5,
    "text-doi": 4,
    "extra-doi": 3,
    "locator-match": 2,
    "title-match": 1,
  };

  const CONF = {
    openalex: 0.98,
    "pdf-links": 0.95,
    "text-doi": 0.9,
    "extra-doi": 0.85,
    "locator-match": 0.7,
    "title-match": 0.6,
  };

  function edge(from, to, via, confidence, evidence) {
    return { from, to, via, confidence, evidence: evidence || null };
  }

  /** Drop claims that older cites newer (1y preprint slack). */
  function yearOk(citingYear, citedYear) {
    if (!citingYear || !citedYear) return true;
    return citedYear <= citingYear + 1;
  }

  /** One edge per ordered pair; via union, confidence = max. */
  function viaList(v) {
    return (Array.isArray(v) ? v : [v]).filter(Boolean).map(String);
  }

  function merge(rawEdges) {
    const map = new Map();
    for (const e of rawEdges) {
      if (!e || !e.from || !e.to || e.from === e.to) continue;
      const k = e.from + "\0" + e.to;
      const prev = map.get(k);
      const vs = viaList(e.via);
      if (prev) {
        prev.confidence = Math.max(prev.confidence, e.confidence);
        for (const v of vs) if (!prev.via.includes(v)) prev.via.push(v);
        if (e.evidence) prev.evidence.push({ via: vs, ...e.evidence });
      } else {
        map.set(k, {
          from: e.from,
          to: e.to,
          confidence: e.confidence,
          via: vs,
          evidence: e.evidence ? [{ via: vs, ...e.evidence }] : [],
          mutual: false,
        });
      }
    }
    return [...map.values()];
  }

  /**
   * Resolve A→B vs B→A.
   * Keep the stronger claim; near-ties prefer chronology; both strong and both
   * possible collapse to one mutual edge (double arrowhead).
   */
  function resolveConflicts(edges, yearOf) {
    const byPair = new Map();
    for (const e of edges) {
      const a = e.from < e.to ? e.from : e.to;
      const b = e.from < e.to ? e.to : e.from;
      const k = a + "\0" + b;
      if (!byPair.has(k)) byPair.set(k, []);
      byPair.get(k).push(e);
    }
    const out = [];
    for (const list of byPair.values()) {
      if (list.length === 1) {
        out.push(list[0]);
        continue;
      }
      const [e1, e2] = list;
      // Prefer higher confidence; near-tie → chronology; else strategy rank.
      const d = e1.confidence - e2.confidence;
      const y1 = yearOf(e1.from);
      const y2 = yearOf(e1.to);
      const can1 = yearOk(y1, y2); // e1.from cites e1.to
      const can2 = yearOk(yearOf(e2.from), yearOf(e2.to));
      if (Math.abs(d) > 0.1) {
        out.push(d > 0 ? e1 : e2);
        continue;
      }
      if (can1 !== can2) {
        out.push(can1 ? e1 : e2);
        continue;
      }
      const bothStrong = e1.confidence >= 0.85 && e2.confidence >= 0.85;
      if (bothStrong && can1 && can2) {
        const keep = e1.confidence >= e2.confidence ? e1 : e2;
        keep.mutual = true;
        keep.via = [...new Set([...e1.via, ...e2.via])];
        keep.evidence = [...e1.evidence, ...e2.evidence];
        keep.confidence = Math.max(e1.confidence, e2.confidence);
        // Stable orientation: older first (or alphabetical).
        if (String(yearOf(keep.from) || 0) > String(yearOf(keep.to) || 0)) {
          const t = keep.from;
          keep.from = keep.to;
          keep.to = t;
        }
        out.push(keep);
        continue;
      }
      const r1 = STRATEGY_RANK[e1.via[0]] || 0;
      const r2 = STRATEGY_RANK[e2.via[0]] || 0;
      out.push(r1 >= r2 ? e1 : e2);
    }
    return out;
  }

  // -- strategies ----------------------------------------------------------

  /**
   * Build the full graph from an adapter.
   * Adapter: listItems, getAttachments, getAttachmentText, getPdfLinkUris
   * Item: { key, itemID, title, doi, date, extra, year, creators, ... }
   */
  async function buildGraph(adapter, opts) {
    opts = opts || {};
    const includeGhosts = opts.includeGhosts !== false;
    const items = await adapter.listItems();
    const byKey = new Map(items.map((i) => [i.key, i]));
    const byDoi = new Map();
    for (const i of items) {
      const d = i.doi ? normDoi(i.doi) : null;
      if (d && !byDoi.has(d)) byDoi.set(d, i.key);
    }
    const yearOf = (key) => {
      const it = byKey.get(key);
      return it ? it.year || firstYear(it.date) : null;
    };

    const raw = [];
    const stats = { "pdf-links": 0, "text-doi": 0, "extra-doi": 0, "title-match": 0 };
    const sections = new Map();

    async function refSection(attKey) {
      if (sections.has(attKey)) return sections.get(attKey);
      const p = adapter.getAttachmentText(attKey).then((text) => (text ? segment(text) : null));
      sections.set(attKey, p);
      return p;
    }

    for (const item of items) {
      const citingYear = item.year || firstYear(item.date);

      // extra + child-note DOIs
      const extraDois = findDois(item.extra || "");
      for (const note of item.notes || []) extraDois.push(...findDois(note));
      for (const d of extraDois) {
        const target = byDoi.get(d);
        if (target && target !== item.key && yearOk(citingYear, yearOf(target))) {
          raw.push(edge(item.key, target, "extra-doi", CONF["extra-doi"], { doi: d }));
          stats["extra-doi"]++;
        }
      }

      const atts = await adapter.getAttachments(item.key);
      for (const att of atts) {
        if (att.contentType === "application/pdf") {
          const uris = await adapter.getPdfLinkUris(att.key);
          const dois = new Set();
          for (const u of uris) for (const d of findDois(u)) dois.add(d);
          // Ignore a PDF whose only DOI link is its own (publisher boilerplate).
          if (!(dois.size === 1 && byDoi.get([...dois][0]) === item.key)) {
            for (const d of dois) {
              const target = byDoi.get(d);
              if (target && target !== item.key && yearOk(citingYear, yearOf(target))) {
                raw.push(
                  edge(item.key, target, "pdf-links", CONF["pdf-links"], {
                    doi: d,
                    attachment: att.key,
                  }),
                );
                stats["pdf-links"]++;
              } else if (!target && includeGhosts) {
                raw.push(
                  edge(item.key, "doi:" + d, "pdf-links", CONF["pdf-links"], {
                    doi: d,
                    external: true,
                  }),
                );
              }
            }
          }
        }

        const seg = await refSection(att.key);
        if (!seg || seg.quality === "none") continue;

        for (const d of findDois(seg.flat)) {
          const target = byDoi.get(d);
          if (target && target !== item.key && yearOk(citingYear, yearOf(target))) {
            raw.push(
              edge(item.key, target, "text-doi", CONF["text-doi"], {
                doi: d,
                segment: seg.quality,
              }),
            );
            stats["text-doi"]++;
          }
        }

        // title-match (simpler than Jajaho's rolling screen — fine at this scale)
        const flat = normTitle(seg.flat);
        const confBy = { heading: 0.8, numbered: 0.75, tail: 0.4 };
        const conf = confBy[seg.quality] || 0.4;
        for (const t of items) {
          if (t.key === item.key) continue;
          const nt = normTitle(t.title);
          if (nt.length < 30) continue;
          if (!yearOk(citingYear, t.year || firstYear(t.date))) continue;
          if (flat.includes(nt)) {
            raw.push(
              edge(item.key, t.key, "title-match", conf, {
                segment: seg.quality,
                matchedTitleChars: nt.length,
              }),
            );
            stats["title-match"]++;
          }
        }
      }
    }

    const merged = merge(raw);
    const resolved = resolveConflicts(merged, yearOf);

    const nodes = new Map();
    const ensure = (key) => {
      if (nodes.has(key)) return nodes.get(key);
      const it = byKey.get(key);
      const n = it
        ? {
            id: key,
            key,
            itemID: it.itemID,
            title: it.title,
            year: it.year || firstYear(it.date),
            doi: it.doi ? normDoi(it.doi) : null,
            creators: it.creators || [],
            venue: it.venue || "",
            collections: it.collections || [],
            collection: it.collection || primaryCollection(it.collections || []),
            hasPdf: !!it.hasPdf,
            ghost: false,
            citedHere: 0,
          }
        : {
            id: key,
            key,
            title: key.startsWith("doi:") ? key.slice(4) : key,
            year: null,
            doi: key.startsWith("doi:") ? key.slice(4) : null,
            creators: [],
            venue: "",
            collections: [],
            collection: "",
            hasPdf: false,
            ghost: true,
            citedHere: 0,
          };
      nodes.set(key, n);
      return n;
    };

    for (const e of resolved) {
      ensure(e.from);
      ensure(e.to).citedHere++;
    }
    if (!includeGhosts) {
      for (const [k, n] of [...nodes]) if (n.ghost) nodes.delete(k);
      for (let i = resolved.length - 1; i >= 0; i--) {
        if (nodes.get(resolved[i].from)?.ghost || nodes.get(resolved[i].to)?.ghost) {
          resolved.splice(i, 1);
        }
      }
    }

    return {
      nodes: [...nodes.values()],
      edges: resolved,
      stats,
      meta: { items: items.length, raw: raw.length, merged: merged.length },
    };
  }

  /**
   * One collection path for coloring. Prefer memberships under scopePath (when
   * given), then the deepest path (most specific subcollection), then lexical
   * order. Empty list → "".
   */
  function primaryCollection(paths, scopePath) {
    const list = (paths || []).map((p) => String(p || "")).filter(Boolean);
    if (!list.length) return "";
    const under = (p) =>
      !scopePath || p === scopePath || p.startsWith(scopePath + "/");
    return list.slice().sort((a, b) => {
      const sa = under(a) ? 0 : 1;
      const sb = under(b) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const da = a.split("/").length;
      const db = b.split("/").length;
      if (da !== db) return db - da;
      return a < b ? -1 : a > b ? 1 : 0;
    })[0];
  }

  /**
   * Distinct hues for a set of category keys (author name, collection path).
   * Evenly spaced on the wheel so N keys are maximally apart — two keys land on
   * opposite hues, never adjacent green/yellow. "?" (and empty) share a muted
   * gray and do not take a hue slot. Build the map from every node, not just
   * the visible ones, so toggling ghosts does not reshuffle colors.
   */
  function assignHues(keys) {
    const seen = new Set();
    for (const k of keys || []) {
      seen.add(k == null || k === "" ? "?" : String(k));
    }
    const painted = [...seen].filter((k) => k !== "?").sort();
    const n = painted.length;
    const map = new Map([["?", "#666"]]);
    painted.forEach((k, i) => {
      const h = n ? Math.round((i * 360) / n) % 360 : 0;
      map.set(k, `hsl(${h} 55% 50%)`);
    });
    return map;
  }

  return {
    DOI_RE,
    normDoi,
    findDois,
    normTitle,
    flattenPdfText,
    firstYear,
    segment,
    edge,
    yearOk,
    merge,
    resolveConflicts,
    buildGraph,
    primaryCollection,
    assignHues,
    STRATEGY_RANK,
    CONF,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = CitegraphEdges;
}
