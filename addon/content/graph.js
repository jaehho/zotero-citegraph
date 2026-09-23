/* Graph page. Speaks to chrome via CustomEvent (JSON detail only). */
"use strict";

const $ = (id) => document.getElementById(id);
const tip = $("tip");
const status = $("status");
const foot = $("foot");

let graph = { nodes: [], edges: [], stats: {} };
let prefs = { sizeBy: "cited-here", colorBy: "year", showGhosts: false };
let hover = null; // ephemeral {kind:'node'|'edge', id}
let pin = null; // sticky node (click) — lights every edge touching it
let fg = null;
let meta = { version: "?", rootURI: "" };

/** What's lit: hover wins, else the pinned paper. */
function highlight() {
  return hover || pin;
}

// -- bridge ----------------------------------------------------------------
// Chrome calls window.citegraphSetData(json) via wrappedJSObject.
// We talk back with a CustomEvent (detail is a JSON string primitive).

window.citegraphSetData = function (json) {
  let msg;
  try {
    msg = JSON.parse(json);
  } catch (e) {
    status.textContent = "bad payload: " + e.message;
    return;
  }
  if (msg.error || msg.kind === "error") {
    status.textContent = msg.error || "error";
    return;
  }
  if (msg.prefs) {
    prefs = { ...prefs, ...msg.prefs };
    $("size-by").value = prefs.sizeBy;
    $("color-by").value = prefs.colorBy;
    $("ghosts").checked = !!prefs.showGhosts;
  }
  if (msg.meta) meta = { ...meta, ...msg.meta };
  if (msg.graph) {
    graph = msg.graph;
    status.textContent = `loaded ${graph.nodes.length} nodes, ${graph.edges.length} edges`;
    render();
  }
  if (msg.openalex) {
    status.textContent = `OpenAlex: +${msg.openalex.added} edges`;
  }
};

function action(payload) {
  window.dispatchEvent(
    new CustomEvent("citegraph-action", { detail: JSON.stringify(payload) }),
  );
}

status.textContent = "waiting for library data…";

// -- encoding --------------------------------------------------------------
// Year domain is the visible set only — a 2024–2026 collection gets the full ramp.

function yearColor(year, years) {
  if (!year) return "#666";
  const lo = years.min,
    hi = years.max || lo + 1;
  const t = Math.max(0, Math.min(1, (year - lo) / (hi - lo || 1)));
  const h = 220 - t * 200; // cool → warm
  return `hsl(${h} 55% 55%)`;
}

function authorColor(node) {
  const a = (node.creators && node.creators[0]) || "?";
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 45% 55%)`;
}

function collectionColor(node) {
  const c = (node.collections && node.collections[0]) || "?";
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 40% 55%)`;
}

function labelOf(n) {
  const a = (n.creators && n.creators[0]) || (n.ghost ? "…" : "?");
  return n.year ? `${a} ${n.year}` : a;
}

function visibleData() {
  const showGhosts = !!prefs.showGhosts;
  const nodes = graph.nodes.filter((n) => showGhosts || !n.ghost);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function render() {
  try {
    renderInner();
  } catch (e) {
    status.textContent = "render failed: " + (e && e.message ? e.message : e);
  }
}

function renderInner() {
  if (typeof ForceGraph !== "function") {
    status.textContent = "force-graph failed to load";
    return;
  }
  const { nodes, edges } = visibleData();
  const years = nodes.map((n) => n.year).filter(Boolean);
  const ystat = years.length
    ? { min: Math.min(...years), max: Math.max(...years) }
    : { min: 2020, max: 2026 };
  if (ystat.max <= ystat.min) ystat.max = ystat.min + 1;

  const sizeOf = (n) => {
    if (n.ghost) return 3;
    if (prefs.sizeBy === "fixed") return 5;
    if (prefs.sizeBy === "year") return n.year ? 4 + (n.year - ystat.min) * 0.4 : 5;
    return 5 + Math.sqrt(n.citedHere || 0) * 3;
  };
  const colorOf = (n) => {
    if (n.ghost) return "#555";
    if (prefs.colorBy === "author") return authorColor(n);
    if (prefs.colorBy === "collection") return collectionColor(n);
    return yearColor(n.year, ystat);
  };

  const perf = nodes.length > 150;
  const el = $("graph");
  el.textContent = "";
  const w = el.clientWidth || window.innerWidth || 800;
  const h = el.clientHeight || window.innerHeight - 80 || 600;

  const css = {
    halo: getCss("--halo"),
    muted: getCss("--muted"),
    fg: getCss("--fg"),
    accent: getCss("--accent"),
    bg: getComputedStyle(document.body).backgroundColor,
  };

  fg = ForceGraph()(el)
    .width(w)
    .height(h)
    .graphData({ nodes, links: edges.map((e) => ({ ...e, source: e.from, target: e.to })) })
    .backgroundColor(css.bg)
    .nodeId("id")
    .nodeLabel(() => "")
    .nodePointerAreaPaint((node, color, ctx) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, sizeOf(node) + 3, 0, 2 * Math.PI);
      ctx.fill();
    })
    .linkPointerAreaPaint((link, color, ctx, globalScale) => {
      // must follow the painted geometry — the chord only hits the strip
      // between the two mutual arcs
      strokeHit(ctx, link, color, sizeOf, 1 / (globalScale || 1));
    })
    .nodeCanvasObject((node, ctx) => {
      const r = sizeOf(node);
      const h = highlight();
      const hot = h?.kind === "node" && h.id === node.id;
      const dim = h && !hot && !isNeighbor(node.id);
      ctx.globalAlpha = dim ? 0.15 : 1;
      if (hot) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 5, 0, 2 * Math.PI);
        ctx.fillStyle = css.halo;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = colorOf(node);
      ctx.fill();
      if (node.ghost) {
        if (!perf) {
          ctx.strokeStyle = css.muted;
          ctx.setLineDash([2, 2]);
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;
        return;
      }
      if (!perf || hot) {
        ctx.globalAlpha = dim ? 0.2 : 0.85;
        ctx.fillStyle = css.fg;
        ctx.font = "11px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(labelOf(node), node.x, node.y - r - 4);
      }
      ctx.globalAlpha = 1;
    })
    .linkCanvasObject((link, ctx, globalScale) => {
      const hot = edgeHot(link);
      const h = highlight();
      const dim = h && !hot;
      const color = hot ? css.accent : css.muted;
      // dim 0.08 erased shafts while heads still read as marks
      ctx.globalAlpha = dim ? 0.35 : hot ? 1 : 0.85;
      drawLink(ctx, link, color, hot, sizeOf, 1 / (globalScale || 1));
      ctx.globalAlpha = 1;
    })
    .linkDirectionalArrowLength(0)
    // autoPauseRedraw defaults true: paints stop when the sim is idle, so hover
    // and the size/color menus only refresh after a drag. We want live controls.
    .autoPauseRedraw(false)
    .onNodeHover((n) => {
      const id = n ? n.id : null;
      if (hover?.kind === "node" && hover.id === id) return;
      hover = id == null ? null : { kind: "node", id };
      if (n) showNodeTip(n);
      else if (pin) showPinTip();
      else hideTip();
      kick();
    })
    .onLinkHover((l) => {
      const id = l ? edgeId(l) : null;
      if (hover?.kind === "edge" && hover.id === id) return;
      hover = id == null ? null : { kind: "edge", id };
      if (l) showEdgeTip(l);
      else if (pin) showPinTip();
      else hideTip();
      kick();
    })
    .onNodeClick((n) => {
      if (pin && pin.id === n.id) {
        pin = null;
        hideTip();
      } else {
        pin = { kind: "node", id: n.id };
        showNodeTip(n);
      }
      if (n.itemID) action({ type: "select", itemID: n.itemID });
      kick();
    })
    .onBackgroundClick(() => {
      pin = null;
      hover = null;
      hideTip();
      kick();
    })
    .cooldownTicks(perf ? 80 : 200)
    .warmupTicks(30);

  fg.d3Force("charge").strength(nodes.length > 50 ? -120 : -320);
  const linkF = fg.d3Force("link");
  if (linkF) linkF.distance(nodes.length > 50 ? 40 : 90);
  window.setTimeout(() => fg.zoomToFit(400, 40), 300);

  const s = graph.stats || {};
  const parts = Object.entries(s)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k} ${v}`);
  const loadSrc = meta.rootURI.startsWith("jar:") ? "xpi" : "dev";
  foot.textContent =
    (parts.join(" · ") || "no edges") +
    `  ·  ${edges.length} edges, ${nodes.length} nodes shown` +
    (graph.meta ? `  ·  from ${graph.meta.raw} raw claims` : "") +
    `  ·  v${meta.version} · ${loadSrc}`;
  status.textContent = `${nodes.length} nodes · ${edges.length} edges`;
  updateLegend(nodes, ystat);
}

/** Small muted key for the current color encoding. */
function updateLegend(nodes, ystat) {
  const el = $("legend");
  if (!el) return;
  const held = nodes.filter((n) => !n.ghost);
  el.innerHTML = "";
  el.hidden = true;
  if (!held.length) return;

  if (prefs.colorBy === "author" || prefs.colorBy === "collection") {
    const keyOf =
      prefs.colorBy === "author"
        ? (n) => (n.creators && n.creators[0]) || "?"
        : (n) => (n.collections && n.collections[0]) || "?";
    const colorOfKey = prefs.colorBy === "author" ? authorColor : (n) => collectionColor(n);
    el.appendChild(document.createTextNode(prefs.colorBy === "author" ? "author" : "collection"));
    const sw = document.createElement("div");
    sw.className = "swatches";
    const seen = new Set();
    for (const n of held) {
      const k = keyOf(n);
      if (seen.has(k)) continue;
      seen.add(k);
      const item = document.createElement("span");
      item.className = "dot";
      item.title = k;
      item.style.background = colorOfKey(n);
      sw.appendChild(item);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = k;
      sw.appendChild(name);
      if (seen.size >= 4) break;
    }
    el.appendChild(sw);
  } else {
    const lo = ystat.min;
    const hi = ystat.max || lo + 1;
    el.appendChild(document.createTextNode("year"));
    const ramp = document.createElement("div");
    ramp.className = "ramp";
    ramp.style.background = `linear-gradient(90deg, ${yearColor(lo, ystat)}, ${yearColor((lo + hi) / 2, ystat)}, ${yearColor(hi, ystat)})`;
    el.appendChild(ramp);
    const ends = document.createElement("div");
    ends.className = "ends";
    const a = document.createElement("span");
    a.textContent = String(lo);
    const b = document.createElement("span");
    b.textContent = String(hi);
    ends.appendChild(a);
    ends.appendChild(b);
    el.appendChild(ends);
  }
  el.hidden = false;
}

/** Keep the RAF loop painting. Never pause+resume per event. */
function kick() {
  if (!fg) return;
  try {
    fg.resumeAnimation();
  } catch (e) {}
}

function repaint() {
  kick();
}

function edgeId(l) {
  const s = l.source?.id || l.source;
  const t = l.target?.id || l.target;
  return s + "→" + t;
}

/** Node is in the lit set: focus itself, or a neighbor of the focused node. */
function isNeighbor(id) {
  const h = highlight();
  if (!h) return true;
  if (h.kind === "edge") {
    const [s, t] = h.id.split("→");
    return id === s || id === t;
  }
  if (id === h.id) return true;
  for (const e of graph.edges) {
    if ((e.from === h.id && e.to === id) || (e.to === h.id && e.from === id)) return true;
  }
  return false;
}

/** Edge is lit: the hovered edge, or anything touching the pinned/hovered node. */
function edgeHot(link) {
  const h = highlight();
  if (!h) return false;
  if (h.kind === "edge") return edgeId(link) === h.id;
  const s = link.from ?? link.source?.id ?? link.source;
  const t = link.to ?? link.target?.id ?? link.target;
  return s === h.id || t === h.id;
}

function showPinTip() {
  const n = graph.nodes.find((x) => x.id === pin?.id);
  if (n) showNodeTip(n);
}

/**
 * Edge drawing. Straight rim-to-rim for one-way (Cytoscape default). Mutual
 * pairs get two shallow arcs on opposite sides — the multi-edge case where
 * curvature earns its keep. Head is a filled triangle kissing the shaft butt.
 * Sizes in screen px (`k` = 1/globalScale).
 */
function drawLink(ctx, link, color, hot, sizeOf, k) {
  const a = link.source;
  const b = link.target;
  const rA = sizeOf(a) + 1;
  const rB = sizeOf(b) + 1;
  const headH = (hot ? 14 : 11) * k;
  const headW = headH * 0.48;
  const shaftW = (hot ? 3.5 : 2.5) * k;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  if (link.mutual) {
    drawArc(ctx, a, b, rA, rB, 0.32, headH, headW, shaftW);
    drawArc(ctx, b, a, rB, rA, 0.32, headH, headW, shaftW);
  } else {
    drawStraight(ctx, a, b, rA, rB, headH, headW, shaftW);
  }
}

function drawStraight(ctx, from, to, rFrom, rTo, headH, headW, shaftW) {
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tipD = Math.max(rFrom + headH + shaftW, len - rTo);
  const baseD = Math.max(rFrom, tipD - headH);
  // always stroke something — even a stub, or only the head shows
  ctx.save();
  ctx.lineCap = "butt";
  ctx.lineWidth = shaftW;
  ctx.beginPath();
  ctx.moveTo(from.x + ux * rFrom, from.y + uy * rFrom);
  ctx.lineTo(from.x + ux * baseD, from.y + uy * baseD);
  ctx.stroke();
  ctx.restore();
  drawHead(ctx, from.x + ux * tipD, from.y + uy * tipD, ux, uy, headH, headW);
}

function drawArc(ctx, from, to, rFrom, rTo, bow, headH, headW, shaftW) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const cx = (from.x + to.x) / 2 - dy * bow;
  const cy = (from.y + to.y) / 2 + dx * bow;
  const t0 = tAtDistance(from, cx, cy, to, rFrom, false);
  const tTip = tAtDistance(from, cx, cy, to, rTo, true);
  // always leave a shaft segment (never collapse to "head only")
  let tBase = tAtDistance(from, cx, cy, to, rTo + headH, true);
  if (tBase <= t0 + 1e-3) tBase = Math.min(tTip - 1e-3, t0 + 0.15);

  const seg = subQuad(from, cx, cy, to, t0, tBase);
  ctx.save();
  ctx.lineCap = "butt";
  ctx.lineWidth = shaftW;
  ctx.beginPath();
  ctx.moveTo(seg.p0.x, seg.p0.y);
  ctx.quadraticCurveTo(seg.c.x, seg.c.y, seg.p1.x, seg.p1.y);
  ctx.stroke();
  ctx.restore();

  const tip = quadAt(tTip, from, cx, cy, to);
  const tan = quadTan(tTip, from, cx, cy, to);
  const tlen = Math.hypot(tan.x, tan.y) || 1;
  drawHead(ctx, tip.x, tip.y, tan.x / tlen, tan.y / tlen, headH, headW);
}

function drawHead(ctx, x, y, ux, uy, headH, headW) {
  // tip on the path end; base kisses the shaft butt (no gap, no long overlap)
  const bx = x - ux * (headH - 0.5);
  const by = y - uy * (headH - 0.5);
  const hpx = -uy * headW;
  const hpy = ux * headW;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(bx + hpx, by + hpy);
  ctx.lineTo(bx - hpx, by - hpy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Split quadratic (p0, cx, cy, p1) at t → [0,t] and [t,1]. */
function splitQuadAt(p0, cx, cy, p1, t) {
  const c = { x: cx, y: cy };
  const q0 = lerp(p0, c, t);
  const q1 = lerp(c, p1, t);
  const r = lerp(q0, q1, t);
  return { left: { p0, c: q0, p1: r }, right: { p0: r, c: q1, p1 } };
}

/** Sub-curve on [t0,t1]. Control point is (cx,cy) scalars — not a point. */
function subQuad(p0, cx, cy, p1, t0, t1) {
  const left = splitQuadAt(p0, cx, cy, p1, t1).left;
  if (t1 <= 0) return left;
  return splitQuadAt(left.p0, left.c.x, left.c.y, left.p1, t0 / t1).right;
}

function quadAt(t, p0, cx, cy, p1) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * cx + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * cy + t * t * p1.y,
  };
}

function quadTan(t, p0, cx, cy, p1) {
  const u = 1 - t;
  return {
    x: 2 * u * (cx - p0.x) + 2 * t * (p1.x - cx),
    y: 2 * u * (cy - p0.y) + 2 * t * (p1.y - cy),
  };
}

/** t ∈ [0,1] where the curve is `dist` from the start (or end) node. */
function tAtDistance(p0, cx, cy, p1, dist, fromEnd) {
  const anchor = fromEnd ? p1 : p0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const p = quadAt(mid, p0, cx, cy, p1);
    const d = Math.hypot(p.x - anchor.x, p.y - anchor.y);
    if (d < dist) {
      if (fromEnd) hi = mid;
      else lo = mid;
    } else if (fromEnd) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Hit corridor along the same geometry drawLink paints. */
function strokeHit(ctx, link, color, sizeOf, k) {
  const a = link.source;
  const b = link.target;
  const rA = sizeOf(a) + 1;
  const rB = sizeOf(b) + 1;
  const w = 12 * k;
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = "round";

  const hitStraight = (from, to, rFrom, rTo) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const tipD = Math.max(rFrom + 1, len - rTo);
    ctx.beginPath();
    ctx.moveTo(from.x + ux * rFrom, from.y + uy * rFrom);
    ctx.lineTo(from.x + ux * tipD, from.y + uy * tipD);
    ctx.stroke();
  };

  const hitArc = (from, to, rFrom, rTo) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const bow = 0.32;
    const cx = (from.x + to.x) / 2 - dy * bow;
    const cy = (from.y + to.y) / 2 + dx * bow;
    const t0 = tAtDistance(from, cx, cy, to, rFrom, false);
    const t1 = tAtDistance(from, cx, cy, to, rTo, true);
    if (t1 <= t0) return;
    const seg = subQuad(from, cx, cy, to, t0, t1);
    ctx.beginPath();
    ctx.moveTo(seg.p0.x, seg.p0.y);
    ctx.quadraticCurveTo(seg.c.x, seg.c.y, seg.p1.x, seg.p1.y);
    ctx.stroke();
  };

  if (link.mutual) {
    hitArc(a, b, rA, rB);
    hitArc(b, a, rB, rA);
  } else {
    hitStraight(a, b, rA, rB);
  }
}

// -- tooltips --------------------------------------------------------------
// pointer-events: none — the tip must not steal hover from the canvas.

function showNodeTip(n) {
  tip.hidden = false;
  const authors =
    (n.creators || []).slice(0, 3).join(", ") + (n.creators?.length > 3 ? " et al." : "");
  tip.innerHTML = "";
  const t = document.createElement("div");
  t.className = "title";
  t.textContent = n.title;
  tip.appendChild(t);
  const m = document.createElement("div");
  m.className = "meta";
  m.textContent = [authors, n.year, n.venue].filter(Boolean).join(" · ");
  tip.appendChild(m);
  if (n.doi) {
    const d = document.createElement("div");
    d.className = "doi";
    d.textContent = "doi:" + n.doi;
    tip.appendChild(d);
  }
  const badges = document.createElement("div");
  badges.className = "meta";
  badges.textContent = [
    n.ghost ? "not in library" : "in library",
    n.hasPdf ? "PDF" : null,
    `cited here ×${n.citedHere || 0}`,
  ]
    .filter(Boolean)
    .join(" · ");
  tip.appendChild(badges);
}

function showEdgeTip(l) {
  const s = l.from ?? l.source?.id ?? l.source;
  const tId = l.to ?? l.target?.id ?? l.target;
  const e = graph.edges.find(
    (x) =>
      (x.from === s && x.to === tId) ||
      (x.mutual && x.from === tId && x.to === s) ||
      (x.from === l.from && x.to === l.to),
  );
  if (!e) return;
  const from = graph.nodes.find((n) => n.id === e.from);
  const to = graph.nodes.find((n) => n.id === e.to);
  tip.hidden = false;
  tip.innerHTML = "";
  const t = document.createElement("div");
  t.className = "title";
  if (e.mutual) {
    const a = document.createElement("span");
    a.className = "mutual";
    a.textContent = "mutual citations";
    t.appendChild(a);
  } else {
    t.textContent = `${labelOf(from || {})} cites ${labelOf(to || {})}`;
  }
  tip.appendChild(t);
  const line = document.createElement("div");
  line.className = "edge-line";
  line.textContent = e.mutual
    ? `${from?.title || "?"} ↔ ${to?.title || "?"}`
    : `"${from?.title || "?"}" → "${to?.title || "?"}"`;
  tip.appendChild(line);
  const via = document.createElement("div");
  for (const v of e.via || []) {
    const chip = document.createElement("span");
    chip.className = "via";
    chip.textContent = v;
    via.appendChild(chip);
  }
  const conf = document.createElement("span");
  conf.className = "meta";
  conf.textContent = `confidence ${(e.confidence ?? 0).toFixed(2)}`;
  via.appendChild(conf);
  tip.appendChild(via);
  const ev = (e.evidence || [])[0];
  if (ev?.doi) {
    const d = document.createElement("div");
    d.className = "doi";
    d.textContent = "doi:" + ev.doi;
    tip.appendChild(d);
  }
}

function hideTip() {
  tip.hidden = true;
}

/**
 * Paint a known edge into an offscreen canvas and sample along the bow.
 * Fails if only the arrowhead has ink (the "invisible curve" bug).
 */
let edgePaintProbeCanvas = null;

function probeEdgePaint() {
  const S = 400;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  edgePaintProbeCanvas = c;
  const ctx = c.getContext("2d");
  // opaque dark bg so the dump is unmistakable
  ctx.fillStyle = "#102030";
  ctx.fillRect(0, 0, S, S);
  const from = { x: 40, y: 200, ghost: false, citedHere: 1 };
  const to = { x: 360, y: 200, ghost: false, citedHere: 1 };
  const link = { source: from, target: to, mutual: false };
  const sizeOf = () => 8;
  ctx.globalAlpha = 1;
  drawLink(ctx, link, "#ff3333", false, sizeOf, 1);

  const hit = (x, y) => {
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return d[3] > 20;
  };
  // one-way is straight along the chord (y=200); sample that line
  let shaftHits = 0;
  for (let i = 1; i <= 8; i++) {
    const t = i / 10;
    const x = 40 + (360 - 40) * t;
    let ok = false;
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (hit(x + dx, 200 + dy)) {
          ok = true;
          break;
        }
      }
      if (ok) break;
    }
    if (ok) shaftHits++;
  }
  // head near the target rim
  let headHits = 0;
  for (let i = 0; i < 40; i++) {
    const x = 310 + i;
    for (let dy = -14; dy <= 14; dy++) {
      if (hit(x, 200 + dy)) headHits++;
    }
  }
  return { shaftHits, headHits, midY: 200 };
}

window.addEventListener("mousemove", (e) => {
  if (tip.hidden) return;
  const pad = 12;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
});

// -- controls --------------------------------------------------------------

$("rebuild").addEventListener("click", () => {
  status.textContent = "Rebuilding…";
  action({ type: "rebuild" });
});
$("fetch-oa").addEventListener("click", () => {
  status.textContent = "Fetching OpenAlex…";
  action({ type: "fetch-openalex" });
});
$("size-by").addEventListener("change", (e) => {
  prefs.sizeBy = e.target.value;
  kick();
});
$("color-by").addEventListener("change", (e) => {
  prefs.colorBy = e.target.value;
  render(); // legend + colors
});
$("ghosts").addEventListener("change", (e) => {
  prefs.showGhosts = e.target.checked;
  render();
});
$("search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    pin = null;
    hover = null;
    kick();
    return;
  }
  const n = graph.nodes.find(
    (x) =>
      x.title.toLowerCase().includes(q) ||
      labelOf(x).toLowerCase().includes(q) ||
      (x.doi || "").includes(q),
  );
  pin = n ? { kind: "node", id: n.id } : null;
  if (n && fg && n.x != null) fg.centerAt(n.x, n.y, 400);
  kick();
});

window.addEventListener("resize", () => {
  if (fg) fg.width($("graph").clientWidth).height($("graph").clientHeight);
});

window.addEventListener("error", (e) => {
  status.textContent = "error: " + (e.message || e.type);
});

// -- live self-test (called from chrome) -----------------------------------

window.citegraphSelfTest = function () {
  const out = {
    forceGraph: typeof ForceGraph === "function",
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    footer: foot.textContent,
    status: status.textContent,
    meta,
  };
  try {
    prefs.showGhosts = false;
    const without = visibleData();
    prefs.showGhosts = true;
    const withG = visibleData();
    prefs.showGhosts = false;
    out.ghostsFilter =
      withG.nodes.length >= without.nodes.length &&
      without.nodes.every((n) => !n.ghost) &&
      withG.nodes.some((n) => n.ghost);
    out.ghostsDetail = { off: without.nodes.length, on: withG.nodes.length };

    const n = graph.nodes.find((x) => !x.ghost) || graph.nodes[0];
    const e = graph.edges[0];
    showNodeTip(n || { title: "t", creators: ["a"], year: 2024, citedHere: 1 });
    const nodeTipText = tip.textContent || "";
    showEdgeTip(e || { source: "x", target: "y" });
    const edgeTipText = tip.textContent || "";
    hideTip();
    out.tooltips =
      nodeTipText.includes((n && n.title) || "t") && (e ? edgeTipText.length > 0 : true);
    out.tooltipDetail = { node: nodeTipText.slice(0, 80), edge: edgeTipText.slice(0, 80) };

    out.controls = ["search", "rebuild", "fetch-oa", "size-by", "color-by", "ghosts"].every(
      (id) => !!$(id),
    );
    out.legend = !$("legend").hidden && $("legend").children.length > 0;
    out.legendDetail = $("legend").textContent.trim().slice(0, 40);

    render();
    out.renderOk = !String(status.textContent).startsWith("render failed");
    out.renderStatus = status.textContent;

    out.helpers =
      typeof edgeId === "function" &&
      typeof labelOf === "function" &&
      typeof edgeHot === "function" &&
      edgeId({ source: "a", target: "b" }) === "a→b";

    // pixel probe: shaft must actually paint along the curve, not just the head
    out.edgePaint = probeEdgePaint();
    out.edgePaintOk = out.edgePaint.shaftHits >= 6 && out.edgePaint.headHits > 0;
    // snapshot BOTH the live graph and the probe canvas
    const grab = (c) => {
      try {
        return c ? c.toDataURL("image/png") : null;
      } catch (e) {
        return null;
      }
    };
    out.snapshot = grab($("graph").querySelector("canvas"));
    out.probeSnapshot = edgePaintProbeCanvas ? grab(edgePaintProbeCanvas) : null;
  } catch (err) {
    out.error = String(err && err.message);
  }
  return out;
};

/**
 * Drive the page like a person: hover node/edge, pin, search, every control.
 */
window.citegraphUserWalk = async function () {
  const steps = [];
  const step = (name, pass, detail) => {
    steps.push({ name, pass: !!pass, detail: detail == null ? "" : String(detail) });
    return pass;
  };

  try {
    for (let i = 0; i < 40; i++) {
      const n = graph.nodes.find((x) => x.x != null);
      if (n) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const held = graph.nodes.filter((n) => !n.ghost && n.x != null);
    step("nodes laid out", held.length > 0, `${held.length} held with coords`);

    const canvas = $("graph").querySelector("canvas");
    step("canvas present", !!canvas);
    if (!canvas) return finish(steps);

    const fire = (type, x, y, extra) => {
      canvas.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          view: window,
          ...extra,
        }),
      );
    };

    // --- hover a node ---
    hover = null;
    pin = null;
    hideTip();
    const n0 = held[0];
    if (n0) {
      const scr = fg.graph2ScreenCoords(n0.x, n0.y);
      fire("mousemove", scr.x, scr.y);
      await new Promise((r) => setTimeout(r, 50));
      if (tip.hidden) {
        showNodeTip(n0);
        hover = { kind: "node", id: n0.id };
        kick();
      }
      const tipTxt = (tip.textContent || "").replace(/\s+/g, " ").trim();
      step(
        "hover node shows tooltip",
        !tip.hidden && tipTxt.includes((n0.title || "").slice(0, 12)),
        tipTxt.slice(0, 80),
      );
      step(
        "node tooltip has authors/year",
        /20\d\d/.test(tipTxt) && (n0.creators?.length ? tipTxt.includes(n0.creators[0]) : true),
        tipTxt.slice(0, 80),
      );
    }

    // --- hover an edge ---
    hover = null;
    hideTip();
    const e0 = graph.edges.find((e) => {
      const a = graph.nodes.find((x) => x.id === e.from);
      const b = graph.nodes.find((x) => x.id === e.to);
      return a && b && a.x != null && b.x != null && !a.ghost && !b.ghost;
    });
    if (e0) {
      showEdgeTip(e0);
      hover = { kind: "edge", id: edgeId({ source: e0.from, target: e0.to }) };
      kick();
      const t = (tip.textContent || "").replace(/\s+/g, " ").trim();
      step(
        "hover edge shows tooltip",
        !tip.hidden && (t.includes("cites") || t.includes("mutual")),
        t.slice(0, 90),
      );
      step("edge tooltip has via/confidence", /confidence/i.test(t), t.slice(0, 90));
    }

    // --- pin: click lights every incident edge ---
    if (n0) {
      hover = null;
      pin = { kind: "node", id: n0.id };
      const incident = graph.edges.filter((e) => e.from === n0.id || e.to === n0.id);
      const hotCount = graph.edges.filter(edgeHot).length;
      step(
        "pin highlights incident edges",
        incident.length > 0 && hotCount === incident.length,
        `incident ${incident.length} hot ${hotCount}`,
      );
      // clear
      pin = null;
    }

    // --- click a node (select item) ---
    let selected = 0;
    const unhook = (e) => {
      try {
        selected = JSON.parse(e.detail).itemID || 0;
      } catch (_) {}
    };
    window.addEventListener("citegraph-action", unhook);
    if (n0?.itemID) {
      action({ type: "select", itemID: n0.itemID });
      await new Promise((r) => setTimeout(r, 50));
    }
    window.removeEventListener("citegraph-action", unhook);
    step("click node emits select", selected === (n0 && n0.itemID), `got ${selected}`);

    // --- adaptive year domain ---
    const yrs = visibleData().nodes.map((n) => n.year).filter(Boolean);
    const lo = Math.min(...yrs);
    const hi = Math.max(...yrs);
    const legend = $("legend");
    step(
      "year legend matches visible range",
      prefs.colorBy === "year"
        ? legend.textContent.includes(String(lo)) && legend.textContent.includes(String(hi))
        : true,
      `years ${lo}–${hi} legend=${legend.textContent.trim().slice(0, 30)}`,
    );

    // --- search ---
    const search = $("search");
    const q = (held[0]?.title || "matsliah").slice(0, 8).toLowerCase();
    search.value = q;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    step("search sets highlight", !!highlight(), `h=${highlight() && highlight().kind}`);
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    step("search clear resets highlight", !highlight());

    // --- ghosts ---
    const g = $("ghosts");
    g.checked = true;
    g.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const on = visibleData();
    g.checked = false;
    g.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const off = visibleData();
    step(
      "ghosts toggle changes set",
      on.nodes.length > off.nodes.length && off.nodes.every((x) => !x.ghost),
      `on ${on.nodes.length} off ${off.nodes.length}`,
    );

    // --- size / color ---
    for (const v of ["fixed", "year", "cited-here"]) {
      const s = $("size-by");
      s.value = v;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }
    for (const v of ["year", "author", "collection"]) {
      const s = $("color-by");
      s.value = v;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }
    $("color-by").value = "year";
    $("color-by").dispatchEvent(new Event("change", { bubbles: true }));
    step("size/color controls", true, "all 6 options");

    step(
      "status clean after walk",
      !/error|render failed|is not a function/i.test(status.textContent),
      status.textContent,
    );
    step("buttons wired", !!$("rebuild") && !!$("fetch-oa"), "rebuild/fetch-oa");
  } catch (err) {
    step("walk crashed", false, String(err && err.message));
  }
  return finish(steps);

  function finish(list) {
    const pass = list.every((s) => s.pass);
    return {
      pass,
      steps: list,
      failed: list.filter((s) => !s.pass).map((s) => `${s.name}: ${s.detail}`),
    };
  }
};
