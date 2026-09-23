"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../addon/edges.js");

test("normDoi strips resolver prefixes and tails", () => {
  assert.equal(E.normDoi("https://doi.org/10.1038/S41586-024-07981-1"), "10.1038/s41586-024-07981-1");
  assert.equal(E.normDoi("doi:10.1016/j.neuron.2026.01.001/abstract"), "10.1016/j.neuron.2026.01.001");
  assert.equal(E.normDoi("10.1016/0017-9310(69)90011-8"), "10.1016/0017-9310(69)90011-8");
  assert.equal(E.normDoi("not-a-doi"), null);
});

test("findDois recovers several and drops truncations", () => {
  const dois = E.findDois("see 10.1038/s41586-024-07981-1 and https://doi.org/10.7554/eLife.21022 also 10.1016/j");
  assert.deepEqual(dois.sort(), ["10.1038/s41586-024-07981-1", "10.7554/elife.21022"].sort());
});

test("yearOk rejects older citing newer", () => {
  // citedYear <= citingYear + 1 (one year of preprint slack)
  assert.equal(E.yearOk(2025, 2024), true); // later cites earlier
  assert.equal(E.yearOk(2024, 2025), true); // slack: 2024 may cite a 2025 preprint
  assert.equal(E.yearOk(2024, 2026), false); // too far ahead
  assert.equal(E.yearOk(2024, 2024), true);
  assert.equal(E.yearOk(null, 2025), true); // unknown years pass
  assert.equal(E.yearOk(2024, null), true);
});

test("merge keeps one edge per pair with via union", () => {
  const merged = E.merge([
    E.edge("A", "B", "title-match", 0.4, { segment: "tail" }),
    E.edge("A", "B", "pdf-links", 0.95, { doi: "10.1/x" }),
    E.edge("B", "A", "text-doi", 0.9, { doi: "10.1/y" }),
  ]);
  assert.equal(merged.length, 2);
  const ab = merged.find((e) => e.from === "A");
  assert.equal(ab.confidence, 0.95);
  assert.deepEqual(ab.via.sort(), ["pdf-links", "title-match"]);
});

test("merge normalizes string via and does not nest arrays", () => {
  const merged = E.merge([
    { from: "A", to: "B", via: "openalex", confidence: 0.98, evidence: null },
    { from: "A", to: "B", via: ["pdf-links"], confidence: 0.95, evidence: null },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].via.sort(), ["openalex", "pdf-links"]);
  assert.ok(merged[0].via.every((v) => typeof v === "string"));
  assert.ok(merged[0].via.includes("openalex"));
});

test("subQuad endpoints match the parent curve (no NaN)", () => {
  // graph.js subQuad(p0, cx, cy, p1, t0, t1) — control is scalars, not a point
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const splitQuadAt = (p0, cx, cy, p1, t) => {
    const c = { x: cx, y: cy };
    const q0 = lerp(p0, c, t);
    const q1 = lerp(c, p1, t);
    const r = lerp(q0, q1, t);
    return { left: { p0, c: q0, p1: r }, right: { p0: r, c: q1, p1 } };
  };
  const subQuad = (p0, cx, cy, p1, t0, t1) => {
    const left = splitQuadAt(p0, cx, cy, p1, t1).left;
    if (t1 <= 0) return left;
    return splitQuadAt(left.p0, left.c.x, left.c.y, left.p1, t0 / t1).right;
  };
  const quadAt = (t, p0, cx, cy, p1) => {
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * cx + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * cy + t * t * p1.y,
    };
  };
  const from = { x: 40, y: 200 };
  const to = { x: 360, y: 200 };
  const cx = 200;
  const cy = 244.8;
  const seg = subQuad(from, cx, cy, to, 0.05, 0.9);
  for (const p of [seg.p0, seg.c, seg.p1]) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), JSON.stringify(p));
  }
  const a = quadAt(0.05, from, cx, cy, to);
  const b = quadAt(0.9, from, cx, cy, to);
  assert.ok(Math.hypot(seg.p0.x - a.x, seg.p0.y - a.y) < 0.5);
  assert.ok(Math.hypot(seg.p1.x - b.x, seg.p1.y - b.y) < 0.5);
});

test("resolveConflicts: chronology wins a near-tie", () => {
  const yearOf = (k) => ({ A: 2024, B: 2026 })[k] || null;
  const out = E.resolveConflicts(
    [
      { from: "A", to: "B", via: ["title-match"], confidence: 0.5, evidence: [], mutual: false },
      { from: "B", to: "A", via: ["pdf-links"], confidence: 0.55, evidence: [], mutual: false },
    ],
    yearOf,
  );
  // near-tie (Δ=0.05 ≤ 0.1): only B→A is chronological
  assert.equal(out.length, 1);
  assert.equal(out[0].from, "B");
  assert.equal(out[0].to, "A");
  assert.ok(!out[0].mutual);
});

test("resolveConflicts: strong two-way becomes one mutual edge", () => {
  const yearOf = (k) => ({ M: 2024, S: 2024 })[k] || null;
  const out = E.resolveConflicts(
    [
      { from: "M", to: "S", via: ["pdf-links"], confidence: 0.95, evidence: [], mutual: false },
      { from: "S", to: "M", via: ["pdf-links"], confidence: 0.95, evidence: [], mutual: false },
    ],
    yearOf,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].mutual, true);
  assert.deepEqual(out[0].via, ["pdf-links"]);
});

test("resolveConflicts: higher confidence wins outright", () => {
  const yearOf = () => null;
  const out = E.resolveConflicts(
    [
      { from: "A", to: "B", via: ["openalex"], confidence: 0.98, evidence: [], mutual: false },
      { from: "B", to: "A", via: ["title-match"], confidence: 0.4, evidence: [], mutual: false },
    ],
    yearOf,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].from, "A");
  assert.ok(!out[0].mutual);
});

// Chiappe-shaped: 2024 Nature package mutuals stay one edge each; no older→newer.
test("chiappe shape: 6 mutual pairs collapse, 2024↛2026 dropped", () => {
  const years = {
    Collie2026: 2026,
    Nern2025: 2025,
    Matsliah2024: 2024,
    Wu2016: 2016,
    Seung2024: 2024,
    Schlegel2024: 2024,
    Lin2024: 2024,
    Dorkenwald2024: 2024,
  };
  const yearOf = (k) => years[k] || null;
  // True mutual pairs from OpenAlex
  const pairs = [
    ["Matsliah2024", "Seung2024"],
    ["Dorkenwald2024", "Matsliah2024"],
    ["Matsliah2024", "Schlegel2024"],
    ["Dorkenwald2024", "Seung2024"],
    ["Dorkenwald2024", "Schlegel2024"],
    ["Dorkenwald2024", "Lin2024"],
  ];
  const raw = [];
  for (const [a, b] of pairs) {
    raw.push(E.edge(a, b, "pdf-links", 0.95));
    raw.push(E.edge(b, a, "pdf-links", 0.95));
  }
  // One-way later cites earlier
  raw.push(E.edge("Nern2025", "Matsliah2024", "openalex", 0.98));
  raw.push(E.edge("Collie2026", "Wu2016", "openalex", 0.98));
  // False claim: 2024 cites 2026 (year guard should have dropped it at emit;
  // resolveConflicts still refuses to keep it over a valid reverse)
  raw.push(E.edge("Matsliah2024", "Nern2025", "title-match", 0.4));

  const merged = E.merge(raw);
  const resolved = E.resolveConflicts(merged, yearOf);
  const mutuals = resolved.filter((e) => e.mutual);
  assert.equal(mutuals.length, 6);
  // The false Matsliah→Nern is near-tied with nothing; it survives merge as its
  // own pair but must lose to Nern→Matsliah on chronology when both exist.
  const mn = resolved.filter(
    (e) =>
      (e.from === "Matsliah2024" && e.to === "Nern2025") ||
      (e.from === "Nern2025" && e.to === "Matsliah2024"),
  );
  assert.equal(mn.length, 1);
  assert.equal(mn[0].from, "Nern2025");
  assert.equal(mn[0].to, "Matsliah2024");
  // No older→newer one-way edges left
  for (const e of resolved) {
    if (e.mutual) continue;
    const yf = yearOf(e.from),
      yt = yearOf(e.to);
    if (yf && yt) assert.ok(yt <= yf + 1, `${e.from}→${e.to}`);
  }
});
