"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../addon/related.js");

// Two topics: A-papers cite x1..x3, B-papers cite y1..y3; every paper cites
// the hub, which is in the library.
function twoTopics() {
  const nodes = [{ id: "hub", title: "Hub dataset paper" }];
  const edges = [];
  for (const [p, refs, title] of [
    ["a", ["x1", "x2", "x3"], "Walking control by descending neurons"],
    ["b", ["y1", "y2", "y3"], "Olfactory coding in the antennal lobe"],
  ]) {
    for (let i = 1; i <= 4; i++) {
      const id = p + i;
      nodes.push({ id, title: `${title} part ${i}` });
      edges.push({ from: id, to: "hub" });
      for (const r of refs) edges.push({ from: id, to: r });
    }
  }
  for (const r of ["x1", "x2", "x3", "y1", "y2", "y3"]) nodes.push({ id: r, ghost: true, title: r });
  return { nodes, edges };
}

test("similarities: a shared rare reference outweighs the shared hub", () => {
  const { nodes, edges } = twoTopics();
  const sim = R.similarities(nodes, edges);
  assert.ok(sim.get("a1").get("a2") > 2 * (sim.get("a1").get("b1") || 0));
  assert.equal(sim.get("x1"), undefined, "ghosts get no row");
});

test("relate: two topics make two groups, the same every run", () => {
  const { nodes, edges } = twoTopics();
  const r = R.relate(nodes, edges);
  const g = (id) => r.groupOf.get(id);
  for (const id of ["a2", "a3", "a4"]) assert.equal(g(id), g("a1"));
  for (const id of ["b2", "b3", "b4"]) assert.equal(g(id), g("b1"));
  assert.notEqual(g("a1"), g("b1"));
  assert.deepEqual([...R.relate(nodes, edges).groupOf], [...r.groupOf]);
  assert.ok(r.modularity > 0.3, `Q ${r.modularity}`);
});

test("louvain: two triangles joined by one weak link split in two", () => {
  const L = (a, b, weight) => ({ a, b, weight });
  const links = [L("a", "b", 1), L("b", "c", 1), L("a", "c", 1), L("d", "e", 1), L("e", "f", 1), L("d", "f", 1), L("c", "d", 0.1)];
  const g = R.louvain(["a", "b", "c", "d", "e", "f"], links);
  assert.equal(g.get("a"), g.get("c"));
  assert.equal(g.get("d"), g.get("f"));
  assert.notEqual(g.get("a"), g.get("d"));
});

test("groupWords: names a group by words its titles share and others lack", () => {
  const { nodes, edges } = twoTopics();
  const r = R.relate(nodes, edges);
  const held = nodes.filter((n) => !n.ghost);
  const words = R.groupWords(held, r.groupOf, 3);
  const walk = words.get(r.groupOf.get("a1")).join(" ");
  assert.match(walk, /walking|descending/);
  assert.doesNotMatch(walk, /part/, "a word in every title says nothing");
});
