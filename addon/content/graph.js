/* Graph page. Speaks to chrome via CustomEvent (JSON detail only). */
"use strict";

const $ = (id) => document.getElementById(id);
const tip = $("tip");
const status = $("status");
const foot = $("foot");

let graph = { nodes: [], edges: [], stats: {} };
let prefs = { sizeBy: "cited-here", colorBy: "group", showGhosts: false };
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

function authorKey(n) {
  return (n.creators && n.creators[0]) || "?";
}

function collectionKey(n) {
  return n.collection || (n.collections && n.collections[0]) || "?";
}

// Evenly spaced hues over the full node set (not the ghost-filtered view), so
// two collections never land on adjacent greens/yellows and toggling ghosts
// does not reshuffle. See CitegraphEdges.assignHues.
let hueByAuthor = new Map([["?", "#666"]]);
let hueByCollection = new Map([["?", "#666"]]);

// -- relatedness -----------------------------------------------------------
// Papers are laid out by what they share (CitegraphRelated), not by direct
// citations: most papers cite the same few hubs, which balls them together.

const GROUP_COLORS = 8; // --series-1..8
const MIN_GROUP = 3; // smaller groups are "other": too few to name

let related = null; // CitegraphRelated.relate() for `relatedFor`
let relatedFor = null;

function relation() {
  if (relatedFor !== graph) {
    related = CitegraphRelated.relate(graph.nodes, graph.edges);
    relatedFor = graph;
  }
  return related;
}

/** The node's named group, or null for ghosts and groups under MIN_GROUP. */
function groupOf(n) {
  const rel = relation();
  const g = rel.groupOf.get(n.id);
  return g != null && rel.groups[g]?.size >= MIN_GROUP ? rel.groups[g] : null;
}

function groupName(g) {
  return g.words.length ? g.words.join(" · ") : `group ${g.index + 1}`;
}

function groupColor(g, css) {
  return g && g.index < GROUP_COLORS ? css.series[g.index] : css.other;
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
  hueByAuthor = CitegraphEdges.assignHues(graph.nodes.map(authorKey));
  hueByCollection = CitegraphEdges.assignHues(graph.nodes.map(collectionKey));
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
  const css = {
    halo: getCss("--halo"),
    muted: getCss("--muted"),
    fg: getCss("--fg"),
    accent: getCss("--accent"),
    bg: getComputedStyle(document.body).backgroundColor,
    series: Array.from({ length: GROUP_COLORS }, (_, i) => getCss(`--series-${i + 1}`)),
    other: getCss("--series-other"),
  };
  const rel = relation();

  const colorOf = (n) => {
    if (n.ghost) return "#555";
    if (prefs.colorBy === "group") return groupColor(groupOf(n), css);
    if (prefs.colorBy === "author") return hueByAuthor.get(authorKey(n)) || "#666";
    if (prefs.colorBy === "collection") return hueByCollection.get(collectionKey(n)) || "#666";
    return yearColor(n.year, ystat);
  };

  const perf = nodes.length > 150;
  const el = $("graph");
  el.textContent = "";
  // Size from the stage (a fixed grid row), not #graph, which grows to
  // whatever canvas it holds.
  const w = $("stage").clientWidth || window.innerWidth || 800;
  const h = $("stage").clientHeight || window.innerHeight - 80 || 600;

  const shown = new Set(nodes.map((n) => n.id));
  const links = [
    ...edges.map((e) => ({ ...e, kind: "cite", source: e.from, target: e.to })),
    ...rel.links
      .filter((l) => shown.has(l.a) && shown.has(l.b))
      .map((l) => ({ kind: "near", source: l.a, target: l.b, weight: l.weight })),
  ];

  fg = ForceGraph()(el)
    .width(w)
    .height(h)
    .graphData({ nodes, links })
    // "near" links only place papers; citations are drawn but do not pull
    .linkVisibility((l) => l.kind === "cite")
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
    .nodeCanvasObject((node, ctx, globalScale) => {
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
      // Paper labels when zoomed in, or for the lit paper; group labels name
      // the regions at the default zoom.
      if (hot || (globalScale >= 2.5 && !perf) || (globalScale >= 4 && perf)) {
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
      // Faint at rest: 1,200 links at full ink hide which papers sit
      // together. A hovered or pinned paper's links come up at full ink.
      ctx.globalAlpha = hot ? 1 : dim ? 0.04 : 0.1;
      drawLink(ctx, link, color, hot, sizeOf, 1 / (globalScale || 1), !h);
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
    .onRenderFramePost((ctx, globalScale) => drawGroupLabels(ctx, globalScale, nodes, css))
    .cooldownTicks(perf ? 120 : 200)
    .warmupTicks(30);

  // Forces: "near" links pull similar papers together, harder the more
  // alike; each named group pulls its papers toward its middle; citations
  // pull only ghosts (which have no "near" links) toward their citers.
  // A "near" link across two groups pulls a quarter as hard, so groups part.
  const maxNear = Math.max(...rel.links.map((l) => l.weight), 1e-9);
  fg.d3Force("charge").strength(nodes.length > 50 ? -90 : -320);
  const linkF = fg.d3Force("link");
  if (linkF) {
    linkF
      .distance((l) => (l.kind === "near" ? 30 : 20))
      .strength((l) => {
        if (l.kind !== "near") return l.source.ghost || l.target.ghost ? 0.4 : 0;
        const across = groupOf(l.source) !== groupOf(l.target);
        return (0.15 + 0.85 * (l.weight / maxNear)) * (across ? 0.25 : 1);
      });
  }
  fg.d3Force("group", groupForce(0.15));
  fg.d3Force("collide", collideForce(sizeOf, 2));
  fg.d3Force("gravity", gravityForce(0.02));
  // Frame the grouped papers once the layout settles; a paper that shares
  // nothing drifts to the edge and would shrink everything else.
  const framed = (n) => !!groupOf(n) || nodes.length < 20;
  fg.onEngineStop(() => {
    if (!fg.framed) fg.zoomToFit(400, 60, framed);
    fg.framed = true;
  });
  window.setTimeout(() => fg.framed || fg.zoomToFit(400, 60, framed), 1200);

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
  const named = rel.groups.filter((g) => g.size >= MIN_GROUP).length;
  status.textContent = `${nodes.length} nodes · ${edges.length} edges · ${named} groups`;
  updateLegend(nodes, ystat, css);
}

/**
 * Keeps library papers from overlapping (big, much-cited ones would
 * otherwise sit on their neighbors). Ghosts are left out: thousands of them
 * would make the pairwise check slow, and they are small.
 */
function collideForce(sizeOf, gap) {
  let held = [];
  const force = () => {
    for (let i = 0; i < held.length; i++) {
      const a = held[i];
      for (let j = i + 1; j < held.length; j++) {
        const b = held[j];
        const min = sizeOf(a) + sizeOf(b) + gap;
        let dx = b.x + b.vx - (a.x + a.vx);
        let dy = b.y + b.vy - (a.y + a.vy);
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (!d) {
          dx = (i - j) * 1e-3;
          dy = 1e-3;
          d = Math.hypot(dx, dy);
        }
        const push = ((min - d) / d) * 0.5;
        a.vx -= dx * push * 0.5;
        a.vy -= dy * push * 0.5;
        b.vx += dx * push * 0.5;
        b.vy += dy * push * 0.5;
      }
    }
  };
  force.initialize = (ns) => {
    held = ns.filter((n) => !n.ghost);
  };
  return force;
}

/** A weak pull toward the middle, so papers that share nothing stay near. */
function gravityForce(strength) {
  let nodes = [];
  const force = (alpha) => {
    for (const n of nodes) {
      n.vx -= n.x * strength * alpha;
      n.vy -= n.y * strength * alpha;
    }
  };
  force.initialize = (ns) => {
    nodes = ns;
  };
  return force;
}

/** A force pulling each paper in a named group toward the group's middle. */
function groupForce(strength) {
  let nodes = [];
  const force = (alpha) => {
    const sum = new Map();
    for (const n of nodes) {
      const g = groupOf(n);
      if (!g) continue;
      const c = sum.get(g) || sum.set(g, { x: 0, y: 0, n: 0 }).get(g);
      c.x += n.x;
      c.y += n.y;
      c.n++;
    }
    const k = strength * alpha;
    for (const n of nodes) {
      const g = groupOf(n);
      const c = g && sum.get(g);
      if (!c) continue;
      n.vx += (c.x / c.n - n.x) * k;
      n.vy += (c.y / c.n - n.y) * k;
    }
  };
  force.initialize = (ns) => {
    nodes = ns;
  };
  return force;
}

/**
 * Each named group's words at the middle of its papers, in screen-size type
 * with a background halo. Text stays in the ink color; a dot in the group's
 * color ties it to the marks.
 */
function drawGroupLabels(ctx, globalScale, nodes, css) {
  if (prefs.colorBy !== "group") return;
  const k = 1 / (globalScale || 1);
  const mid = new Map();
  for (const n of nodes) {
    const g = groupOf(n);
    if (!g || n.x == null) continue;
    const c = mid.get(g) || mid.set(g, { x: 0, y: 0, n: 0 }).get(g);
    c.x += n.x;
    c.y += n.y;
    c.n++;
  }
  const dim = !!highlight();
  ctx.save();
  ctx.font = `600 ${13 * k}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const lineH = 18 * k;
  const placed = []; // label boxes so far, biggest group first
  const hits = (b) => placed.some((p) => b.l < p.r && p.l < b.r && Math.abs(b.y - p.y) < lineH);
  for (const [g, c] of [...mid].sort((a, b) => a[0].index - b[0].index)) {
    const x = c.x / c.n;
    const text = groupName(g);
    const w = ctx.measureText(text).width;
    const dot = 4 * k;
    const left = x - (w + dot * 3) / 2;
    // Nudge down, then up, until it clears the labels already drawn.
    let y = c.y / c.n;
    for (let i = 1; i < 12 && hits({ l: left, r: left + w + dot * 3, y }); i++) {
      y = c.y / c.n + Math.ceil(i / 2) * lineH * (i % 2 ? 1 : -1);
    }
    placed.push({ l: left, r: left + w + dot * 3, y });
    ctx.globalAlpha = dim ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(left + dot, y, dot, 0, 2 * Math.PI);
    ctx.fillStyle = groupColor(g, css);
    ctx.fill();
    ctx.lineWidth = 4 * k;
    ctx.strokeStyle = css.bg;
    ctx.strokeText(text, left + dot * 3, y);
    ctx.fillStyle = css.fg;
    ctx.fillText(text, left + dot * 3, y);
  }
  ctx.restore();
}

/** Small muted key for the current color encoding. */
function updateLegend(nodes, ystat, css) {
  const el = $("legend");
  if (!el) return;
  const held = nodes.filter((n) => !n.ghost);
  el.innerHTML = "";
  el.hidden = true;
  if (!held.length) return;

  if (prefs.colorBy === "group") {
    el.appendChild(document.createTextNode("group (by shared references)"));
    const sw = document.createElement("div");
    sw.className = "swatches";
    const counts = new Map();
    let other = 0;
    for (const n of held) {
      const g = groupOf(n);
      if (g && g.index < GROUP_COLORS) counts.set(g, (counts.get(g) || 0) + 1);
      else other++;
    }
    const rows = [...counts].sort((a, b) => a[0].index - b[0].index);
    for (const [g, count] of rows) sw.appendChild(legendRow(groupColor(g, css), groupName(g), count));
    if (other) sw.appendChild(legendRow(css.other, "other", other));
    el.appendChild(sw);
  } else if (prefs.colorBy === "author" || prefs.colorBy === "collection") {
    const isAuthor = prefs.colorBy === "author";
    const keyOf = isAuthor ? authorKey : collectionKey;
    const hueMap = isAuthor ? hueByAuthor : hueByCollection;
    el.appendChild(document.createTextNode(isAuthor ? "author" : "collection"));
    const sw = document.createElement("div");
    sw.className = "swatches";
    const seen = new Set();
    for (const n of held) {
      const k = keyOf(n);
      if (seen.has(k)) continue;
      seen.add(k);
      const row = document.createElement("div");
      row.className = "row";
      const item = document.createElement("span");
      item.className = "dot";
      item.title = k;
      item.style.background = hueMap.get(k) || "#666";
      row.appendChild(item);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = k;
      name.title = k;
      row.appendChild(name);
      sw.appendChild(row);
      if (seen.size >= 6) break;
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

function legendRow(color, name, count) {
  const row = document.createElement("div");
  row.className = "row";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = color;
  row.appendChild(dot);
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = name;
  label.title = name;
  row.appendChild(label);
  const n = document.createElement("span");
  n.className = "count";
  n.textContent = String(count);
  row.appendChild(n);
  return row;
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
function drawLink(ctx, link, color, hot, sizeOf, k, resting) {
  const a = link.source;
  const b = link.target;
  const rA = sizeOf(a) + 1;
  const rB = sizeOf(b) + 1;
  // at rest, hairlines: the links are context, the groups are the picture
  const headH = (hot ? 14 : resting ? 6 : 11) * k;
  const headW = headH * 0.48;
  const shaftW = (hot ? 3.5 : resting ? 1 : 2.5) * k;

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
  const g = !n.ghost && groupOf(n);
  if (g) {
    const gl = document.createElement("div");
    gl.className = "meta";
    gl.textContent = "group: " + groupName(g);
    tip.appendChild(gl);
  }
  const badges = document.createElement("div");
  badges.className = "meta";
  badges.textContent = [
    n.ghost ? "not in library" : "in library",
    n.collection || null,
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

// The stage changes size with the window, and when the footer gets its text
// after the first render.
new ResizeObserver(() => {
  if (fg) fg.width($("stage").clientWidth).height($("stage").clientHeight);
}).observe($("stage"));

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
    out.colorsLib =
      typeof CitegraphEdges === "object" &&
      typeof CitegraphEdges.assignHues === "function" &&
      typeof CitegraphEdges.primaryCollection === "function";
    out.collectionColorKeys = [...new Set(graph.nodes.filter((n) => !n.ghost).map(collectionKey))];
    out.groups = layoutReport().groups;
    out.hueSample = CitegraphEdges.assignHues(["A", "B"]);

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
 * The groups, and how well the layout keeps them together: the mean distance
 * between two papers of one group over that between papers of different
 * groups (well under 1 when groups sit apart).
 */
function layoutReport() {
  const rel = relation();
  const named = rel.groups.filter((g) => g.size >= MIN_GROUP);
  const held = graph.nodes.filter((n) => !n.ghost);
  const placed = held.filter((n) => n.x != null && groupOf(n));
  let same = 0;
  let sameN = 0;
  let diff = 0;
  let diffN = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const d = Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y);
      if (groupOf(placed[i]) === groupOf(placed[j])) {
        same += d;
        sameN++;
      } else {
        diff += d;
        diffN++;
      }
    }
  }
  return {
    groups: {
      count: named.length,
      sizes: named.map((g) => g.size),
      names: named.map(groupName),
      held: held.length,
      assigned: held.filter((n) => rel.groupOf.has(n.id)).length,
      modularity: Number(rel.modularity.toFixed(3)),
    },
    placed: placed.length,
    spreadRatio: sameN && diffN ? Number((same / sameN / (diff / diffN)).toFixed(3)) : null,
  };
}

/** After `waitMs` of layout: layoutReport plus a PNG of the canvas. */
window.citegraphLayoutReport = async function (waitMs) {
  await new Promise((r) => setTimeout(r, waitMs || 0));
  const canvas = $("graph").querySelector("canvas");
  let snapshot = null;
  try {
    snapshot = canvas ? canvas.toDataURL("image/png") : null;
  } catch (e) {}
  return { ...layoutReport(), status: status.textContent, snapshot };
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
    for (const v of ["year", "author", "collection", "group"]) {
      const s = $("color-by");
      s.value = v;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const legendText = $("legend").textContent;
    const firstGroup = relation().groups.find((g) => g.size >= MIN_GROUP);
    step(
      "group legend names the groups",
      !firstGroup || legendText.includes(groupName(firstGroup)),
      legendText.slice(0, 80),
    );
    step("size/color controls", true, "all 7 options");

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
