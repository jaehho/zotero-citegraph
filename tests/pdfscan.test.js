"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const S = require("../addon/pdfscan.js");

const inflate = (b) => new Uint8Array(zlib.inflateSync(b));
const bytes = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p, "latin1"))));

test("finds plain link annotations and unescapes parentheses", () => {
  const pdf = bytes(
    "1 0 obj << /Type /Annot /A << /S /URI /URI (https://doi.org/10.1038/nature12320) >> >> endobj\n",
    "2 0 obj << /A << /URI (https://example.org/a\\(b\\)) >> >> endobj\n",
  );
  assert.deepEqual(S.scanUriAnnotations(pdf, null).sort(), [
    "https://doi.org/10.1038/nature12320",
    "https://example.org/a(b)",
  ]);
});

test("finds links inside a compressed object stream", () => {
  const packed = zlib.deflateSync(Buffer.from("<< /A << /URI (https://doi.org/10.7554/eLife.21022) >> >>", "latin1"));
  const pdf = bytes(
    `5 0 obj << /Type /ObjStm /Filter /FlateDecode /Length ${packed.length} >> stream\n`,
    packed.toString("latin1"),
    "\nendstream endobj\n",
  );
  assert.deepEqual(S.scanUriAnnotations(pdf, inflate), ["https://doi.org/10.7554/eLife.21022"]);
  assert.deepEqual(S.scanUriAnnotations(pdf, null), []);
});
