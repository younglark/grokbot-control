"use strict";
/**
 * t184: static pins for the helper-unit audit (port-coverage.md §10).
 * Reads D: daemon.formatted.cjs and our src only — never executes official binaries.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const D =
  process.env.DAEMON_FORMATTED ||
  "/workspace/grokbot-node-analysis-0793/daemon.formatted.cjs";
const SRC = path.join(__dirname, "..", "src");

function readSrcTree(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "generated") continue;
      readSrcTree(p, acc);
    } else if (ent.name.endsWith(".ts")) acc.push(fs.readFileSync(p, "utf8"));
  }
  return acc;
}

describe("t184 helper-unit audit pins", () => {
  it("D: noFollow is only consumed by cp/YR; sole root caller is sce→WUe (keepDamaged)", () => {
    const text = fs.readFileSync(D, "utf8");
    const lines = text.split("\n");
    // Every "noFollow" occurrence
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("noFollow")) hits.push(i + 1);
    }
    // Only the two destructuring sites in cp/YR (D:80592, 80605)
    assert.deepEqual(hits, [80592, 80605], `unexpected noFollow lines: ${hits}`);
    // sce(path, { root }) is the only way into oce; WUe calls sce
    assert.match(lines[82148], /sce\(t,\s*\{\s*root:\s*e\s*\}\)/); // WUe D:82149
    assert.match(lines[80616], /function sce\(/); // D:80617
    // keepDamagedCopy uses eGt (D:82171) inside pue (D:82197 area)
    assert.match(lines[82170], /function eGt\(/);
    assert.match(text, /keepDamagedCopy:\s*\(\)\s*=>/);
  });

  it("D: lgt settingsStore uses getters only (no loadForWrite/persist)", () => {
    const lines = fs.readFileSync(D, "utf8").split("\n");
    // lgt body roughly 179109–179470; collect N.<method>
    const body = lines.slice(179108, 179469).join("\n");
    const methods = [...body.matchAll(/\bN\.(\w+)/g)].map((m) => m[1]);
    assert.ok(methods.length > 0, "expected N.* uses in lgt");
    for (const m of methods) {
      assert.match(
        m,
        /^get/,
        `lgt must only call settings getters, found N.${m}`,
      );
    }
    assert.ok(methods.includes("getLocalToolPermission"));
    assert.ok(!body.includes("loadForWrite"));
    assert.ok(!body.includes("keepDamagedCopy"));
  });

  it("D: settings read onDamage always passes copyPath: null", () => {
    const lines = fs.readFileSync(D, "utf8").split("\n");
    // reportUnreadable / readText onDamage sites
    const slice = lines.slice(82230, 82270).join("\n");
    const copyPaths = [...slice.matchAll(/copyPath:\s*([^,\n]+)/g)].map((m) =>
      m[1].trim(),
    );
    assert.ok(copyPaths.length >= 2, copyPaths);
    assert.ok(copyPaths.every((c) => c === "null"));
  });

  it("our src never emits invariant_violation; damaged logs use copy=none", () => {
    const src = readSrcTree(SRC).join("\n");
    assert.equal(src.includes("invariant_violation"), false);
    assert.equal(src.includes("sand.local_exec_daemon.invariant_violation"), false);
    assert.match(src, /durable file damaged path=settings\.json cause=.*copy=none/);
    // fs-write documents default path without noFollow
    const fsWrite = fs.readFileSync(
      path.join(SRC, "state", "fs-write.ts"),
      "utf8",
    );
    assert.match(fsWrite, /without noFollow/);
  });
});
