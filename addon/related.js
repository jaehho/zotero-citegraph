/* Which library papers are related, and into what groups they fall. Pure JS —
 * loaded by the graph page and in node --test.
 *
 * Direct citations make a poor layout: most papers in a field cite the same
 * few hubs, so every paper sits one hop from every other. Shared references
 * (bibliographic coupling) and shared citers (co-citation) say which papers
 * work on the same thing.
 */
"use strict";

var CitegraphRelated = (function () {
  function pairKey(a, b) {
    return a < b ? a + "\0" + b : b + "\0" + a;
  }

  /**
   * Similarity of every pair of library papers that share anything. Each
   * paper is a set of features: "r:" + each work it cites (in the library or
   * not) and "c:" + each library paper that cites it. A feature weighs
   * log(papers / papers with it), so a reference everyone cites says little.
   * Similarity is the cosine of the weighted sets, plus `citeBonus` when one
   * paper cites the other.
   * @returns {Map<string, Map<string, number>>} id -> (id -> similarity)
   */
  function similarities(nodes, edges, opts) {
    const citeBonus = opts?.citeBonus ?? 0.1;
    const ids = nodes.filter((n) => !n.ghost).map((n) => n.id);
    const held = new Set(ids);
    const feats = new Map(ids.map((id) => [id, new Set()]));
    const direct = new Set();
    const cite = (from, to) => {
      if (!held.has(from)) return;
      feats.get(from).add("r:" + to);
      if (held.has(to)) {
        feats.get(to).add("c:" + from);
        direct.add(pairKey(from, to));
      }
    };
    for (const e of edges) {
      cite(e.from, e.to);
      if (e.mutual) cite(e.to, e.from);
    }

    const byFeat = new Map();
    for (const [id, fs] of feats) {
      for (const f of fs) {
        const list = byFeat.get(f);
        if (list) list.push(id);
        else byFeat.set(f, [id]);
      }
    }
    const N = ids.length;
    const weight = (f) => Math.log(N / byFeat.get(f).length);
    const norm = new Map();
    for (const [id, fs] of feats) {
      let s = 0;
      for (const f of fs) s += weight(f) ** 2;
      norm.set(id, Math.sqrt(s));
    }

    const dot = new Map(); // pairKey -> sum of shared weights²
    for (const [f, list] of byFeat) {
      if (list.length < 2) continue;
      const w2 = weight(f) ** 2;
      if (!w2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const k = pairKey(list[i], list[j]);
          dot.set(k, (dot.get(k) || 0) + w2);
        }
      }
    }
    for (const k of direct) if (!dot.has(k)) dot.set(k, 0);

    const sim = new Map(ids.map((id) => [id, new Map()]));
    for (const [k, d] of dot) {
      const [a, b] = k.split("\0");
      const na = norm.get(a);
      const nb = norm.get(b);
      const s = (na && nb ? d / (na * nb) : 0) + (direct.has(k) ? citeBonus : 0);
      if (s <= 0) continue;
      sim.get(a).set(b, s);
      sim.get(b).set(a, s);
    }
    return sim;
  }

  /**
   * Each paper's `k` most similar papers, as undirected links (a pair either
   * side picked appears once). Ties break on id, so the result is stable.
   * @returns {{a: string, b: string, weight: number}[]}
   */
  function nearestLinks(sim, k) {
    const out = new Map();
    for (const [a, row] of sim) {
      const best = [...row].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, k);
      for (const [b, w] of best) {
        const key = pairKey(a, b);
        if (!out.has(key)) out.set(key, { a: a < b ? a : b, b: a < b ? b : a, weight: w });
      }
    }
    return [...out.values()];
  }

  /**
   * Louvain community detection (Blondel et al. 2008) on weighted undirected
   * links. Deterministic: nodes are visited in id order, never shuffled.
   * @returns {Map<string, number>} id -> community, numbered from 0 by size
   */
  function louvain(ids, links) {
    const sorted = [...ids].sort();
    const index = new Map(sorted.map((id, i) => [id, i]));
    // adj[i]: Map j -> weight; a self-loop holds twice the inner weight
    let adj = sorted.map(() => new Map());
    const add = (m, i, j, w) => m[i].set(j, (m[i].get(j) || 0) + w);
    for (const l of links) {
      const i = index.get(l.a);
      const j = index.get(l.b);
      if (i == null || j == null || i === j || !(l.weight > 0)) continue;
      add(adj, i, j, l.weight);
      add(adj, j, i, l.weight);
    }
    let member = sorted.map((_, i) => i); // original node -> current node

    for (;;) {
      const n = adj.length;
      const deg = adj.map((row) => [...row.values()].reduce((s, w) => s + w, 0));
      const m2 = deg.reduce((s, d) => s + d, 0);
      if (!m2) break;
      const comm = adj.map((_, i) => i);
      const tot = deg.slice();
      let moved = false;
      for (let pass = 0; pass < 100; pass++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
          const ci = comm[i];
          const toComm = new Map();
          for (const [j, w] of adj[i]) {
            if (j !== i) toComm.set(comm[j], (toComm.get(comm[j]) || 0) + w);
          }
          tot[ci] -= deg[i];
          const gain = (c) => (toComm.get(c) || 0) - (tot[c] * deg[i]) / m2;
          let best = ci;
          let bestGain = gain(ci);
          for (const c of toComm.keys()) {
            const g = gain(c);
            if (g > bestGain + 1e-12) {
              best = c;
              bestGain = g;
            }
          }
          tot[best] += deg[i];
          if (best !== ci) {
            comm[i] = best;
            changed = true;
            moved = true;
          }
        }
        if (!changed) break;
      }
      if (!moved) break;

      // Aggregate: each community becomes one node.
      const renum = new Map();
      for (const c of comm) if (!renum.has(c)) renum.set(c, renum.size);
      const next = [...renum.keys()].map(() => new Map());
      for (let i = 0; i < n; i++) {
        for (const [j, w] of adj[i]) add(next, renum.get(comm[i]), renum.get(comm[j]), w);
      }
      member = member.map((v) => renum.get(comm[v]));
      adj = next;
    }

    // Number communities by size, largest first; ties by first member id.
    const groups = new Map();
    member.forEach((c, i) => {
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(sorted[i]);
    });
    const order = [...groups.values()].sort((x, y) => y.length - x.length || (x[0] < y[0] ? -1 : 1));
    const out = new Map();
    order.forEach((list, g) => list.forEach((id) => out.set(id, g)));
    return out;
  }

  /** Q = Σ_c (inner_c / m - (deg_c / 2m)²), for tests and the status line. */
  function modularity(groupOf, links) {
    let m = 0;
    const inner = new Map();
    const deg = new Map();
    for (const l of links) {
      m += l.weight;
      const ga = groupOf.get(l.a);
      const gb = groupOf.get(l.b);
      deg.set(ga, (deg.get(ga) || 0) + l.weight);
      deg.set(gb, (deg.get(gb) || 0) + l.weight);
      if (ga === gb) inner.set(ga, (inner.get(ga) || 0) + l.weight);
    }
    if (!m) return 0;
    let q = 0;
    for (const [g, d] of deg) q += (inner.get(g) || 0) / m - (d / (2 * m)) ** 2;
    return q;
  }

  const STOP = new Set(
    (
      "about above across after against along among analysis approach based " +
      "becomes before behind being between beyond both during each from have " +
      "into many more most novel only other over role same some such than that " +
      "their them then there these they this those through toward towards under " +
      "using versus very what when where which while with within without " +
      "reveal reveals revealed study studies"
    ).split(" "),
  );

  /** A title's distinct content terms: words, and pairs of adjacent words. */
  function titleTerms(title) {
    const tokens = String(title || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/<[^>]*>/g, " ")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const content = (w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w);
    const terms = new Set();
    for (let i = 0; i < tokens.length; i++) {
      if (!content(tokens[i])) continue;
      terms.add(tokens[i]);
      if (i + 1 < tokens.length && content(tokens[i + 1])) terms.add(tokens[i] + " " + tokens[i + 1]);
    }
    return [...terms];
  }

  /** Folds plurals onto singulars, so "neurons" and "neuron" count once. */
  function stem(term) {
    return term
      .split(" ")
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
      .join(" ");
  }

  /**
   * Up to `max` terms that set each group's titles apart: common in its
   * titles and rarer elsewhere (score p·log(p/q), p the share of the group's
   * titles with the term, q the share of all titles). A term must appear in
   * two of the group's titles; a chosen pair hides its single words.
   * @param {{id, title}[]} nodes
   * @returns {Map<number, string[]>} group -> terms
   */
  function groupWords(nodes, groupOf, max) {
    max = max || 3;
    const N = nodes.length;
    const df = new Map(); // stem -> titles with it
    const tf = new Map(); // group -> stem -> titles with it
    const size = new Map();
    const form = new Map(); // stem -> surface form -> count
    for (const n of nodes) {
      const g = groupOf.get(n.id);
      size.set(g, (size.get(g) || 0) + 1);
      if (!tf.has(g)) tf.set(g, new Map());
      const seen = new Set();
      for (const t of titleTerms(n.title)) {
        const s = stem(t);
        if (seen.has(s)) continue;
        seen.add(s);
        df.set(s, (df.get(s) || 0) + 1);
        tf.get(g).set(s, (tf.get(g).get(s) || 0) + 1);
        if (!form.has(s)) form.set(s, new Map());
        form.get(s).set(t, (form.get(s).get(t) || 0) + 1);
      }
    }
    const out = new Map();
    for (const [g, counts] of tf) {
      const ranked = [...counts]
        .filter(([, c]) => c >= 2)
        .map(([s, c]) => {
          const p = c / size.get(g);
          return [s, p * Math.log(p / (df.get(s) / N))];
        })
        .filter(([, score]) => score > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const picked = [];
      for (let [s] of ranked) {
        if (picked.length >= max) break;
        // "experience" mostly as "experience dependent": take the pair
        if (!s.includes(" ")) {
          const pair = ranked.find(
            ([t]) => t.split(" ").length === 2 && t.split(" ").includes(s) && counts.get(t) >= (2 / 3) * counts.get(s),
          );
          if (pair) s = pair[0];
        }
        const words = s.split(" ");
        // skip a word already inside a picked pair, or a pair over a picked word
        if (picked.some((p) => p === s || p.split(" ").some((w) => words.includes(w)))) continue;
        picked.push(s);
      }
      out.set(
        g,
        picked.map((s) => [...form.get(s)].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]),
      );
    }
    return out;
  }

  /**
   * Everything the graph page needs to lay papers out by relatedness.
   * @returns {{groupOf: Map<string, number>, groups: {index, size, words}[],
   *   links: {a, b, weight}[], modularity: number}}
   */
  function relate(nodes, edges, opts) {
    const k = opts?.neighbors ?? 6;
    const held = nodes.filter((n) => !n.ghost);
    const links = nearestLinks(similarities(nodes, edges, opts), k);
    const groupOf = louvain(
      held.map((n) => n.id),
      links,
    );
    const words = groupWords(held, groupOf, 3);
    const sizes = new Map();
    for (const g of groupOf.values()) sizes.set(g, (sizes.get(g) || 0) + 1);
    const groups = [...sizes]
      .sort((a, b) => a[0] - b[0])
      .map(([index, size]) => ({ index, size, words: words.get(index) || [] }));
    return { groupOf, groups, links, modularity: modularity(groupOf, links) };
  }

  return { similarities, nearestLinks, louvain, modularity, groupWords, titleTerms, relate };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = CitegraphRelated;
}
