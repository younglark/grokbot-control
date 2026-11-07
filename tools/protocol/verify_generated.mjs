#!/usr/bin/env node
/**
 * Static-only consistency check: generated protobuf-es JS  vs  snapshot.json.
 *
 * snapshot.json is produced by grokbot-proto `extract_proto.py` from the App's
 * proto.cjs by TEXT parsing (the App bundle is never executed). This script
 * imports only the GENERATED files (our own output) and checks, for every
 * message / enum / service in the snapshot:
 *   - field numbers, names, kind, scalar/ref type, repeated, optional, map K/V
 *   - enum value numbers + names
 *   - service methods: name, I/O type names, streaming kind
 * then performs a binary + JSON round-trip of every message type populated
 * with deterministic sample values (encode -> decode -> encode must be equal).
 *
 * Unlike upstream verify/{compare,cross-wire}.mjs this does NOT require()
 * the App's proto.cjs, so it cannot prove App-side encoding equality; it
 * proves the generated code matches the statically extracted schema.
 *
 * Usage: node verify_generated.mjs <generated-js-dir> <snapshot.json> [--only-files a.js,b.js]
 * Exit 0 = no mismatch.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const [dir, snapPath] = process.argv.slice(2);
if (!dir || !snapPath) {
  console.error("usage: node verify_generated.mjs <generated-js-dir> <snapshot.json>");
  process.exit(2);
}
const onlyIdx = process.argv.indexOf("--only-files");
const only = onlyIdx > 0 ? new Set(process.argv[onlyIdx + 1].split(",")) : null;
const snap = JSON.parse(readFileSync(snapPath, "utf8"));
const SCALAR = { 1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32", 6: "fixed64", 7: "fixed32", 8: "bool", 9: "string", 12: "bytes", 13: "uint32", 15: "sfixed32", 16: "sfixed64", 17: "sint32", 18: "sint64" };

const messages = new Map(), enums = new Map(), services = new Map();
// resolve @bufbuild/protobuf the same way the generated files do
const { proto3 } = createRequire(path.resolve(dir, "x.js"))("@bufbuild/protobuf");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".js")).sort()) {
  if (only && !only.has(f)) continue;
  const mod = await import(pathToFileURL(path.resolve(dir, f)).href);
  for (const v of Object.values(mod)) {
    if (!v || typeof v.typeName !== "string") continue;
    if (v.methods) services.set(v.typeName, v);
    else if (v.fields) messages.set(v.typeName, v);
    else if (v.values) enums.set(v.typeName, v);
  }
  for (const v of Object.values(mod)) {
    if (v && typeof v === "object" && !v.typeName) {
      try { const e = proto3.getEnumType(v); enums.set(e.typeName, e); } catch {}
    }
  }
}
// nested types are reachable only via fields
const visit = (t) => {
  if (!t?.typeName || messages.has(t.typeName)) return;
  messages.set(t.typeName, t);
  for (const fi of t.fields.list()) {
    if (fi.kind === "message") visit(fi.T);
    if (fi.kind === "map" && fi.V.kind === "message") visit(fi.V.T);
    if (fi.kind === "enum") enums.set(fi.T.typeName, fi.T);
  }
};
for (const m of [...messages.values()]) { messages.delete(m.typeName); visit(m); }
for (const m of messages.values()) for (const fi of m.fields.list()) {
  if (fi.kind === "enum") enums.set(fi.T.typeName, fi.T);
  if (fi.kind === "map" && fi.V.kind === "enum") enums.set(fi.V.T.typeName, fi.V.T);
}

const typeOf = (fi) => {
  if (fi.kind === "scalar") return SCALAR[fi.T];
  if (fi.kind === "message" || fi.kind === "enum") return fi.T.typeName;
  return "?";
};
const errors = [];
let mChecked = 0, eChecked = 0, rpcChecked = 0, wireOk = 0;
const skipped = [];
for (const [name, fields] of Object.entries(snap.messages)) {
  const t = messages.get(name);
  if (!t) { skipped.push(name); continue; }
  mChecked++;
  const gen = new Map(t.fields.list().map((fi) => [fi.no, fi]));
  if (gen.size !== fields.length) errors.push(`${name}: field count ${fields.length} != ${gen.size}`);
  for (const sf of fields) {
    const fi = gen.get(sf.no);
    if (!fi) { errors.push(`${name}#${sf.no} missing`); continue; }
    const wantKind = sf.kind === "named" ? (sf.T in snap.enums ? "enum" : "message") : sf.kind;
    const want = [sf.name, wantKind, sf.kind === "map" ? `${SCALAR[sf.K] ?? sf.K},${sf.V}` : sf.T, Boolean(sf.repeated), Boolean(sf.opt)].join("|");
    const got = [fi.name, fi.kind,
      fi.kind === "map" ? `${SCALAR[fi.K]},${fi.V.kind === "scalar" ? SCALAR[fi.V.T] : fi.V.T.typeName}` : typeOf(fi),
      Boolean(fi.repeated), Boolean(fi.opt)].join("|");
    if (want !== got) errors.push(`${name}#${sf.no}: ${want} != ${got}`);
  }
}
for (const [name, vals] of Object.entries(snap.enums)) {
  const e = enums.get(name);
  if (!e) { if (!only) skipped.push(name); continue; }
  eChecked++;
  const got = e.values.map((v) => `${v.no}:${v.name}`).join(",");
  const want = vals.map((v) => `${v.no}:${v.name}`).join(",");
  if (got !== want) errors.push(`enum ${name}: values differ`);
}
const KIND = { 0: "Unary", 1: "ServerStreaming", 2: "ClientStreaming", 3: "BiDiStreaming" };
for (const [name, rpcs] of Object.entries(snap.services)) {
  const s = services.get(name);
  if (!s) { if (!only || name.endsWith("GrokBotService")) skipped.push(name); continue; }
  const gm = new Map(Object.values(s.methods).map((m) => [m.name, m]));
  for (const r of rpcs) {
    rpcChecked++;
    const m = gm.get(r.name);
    if (!m) { errors.push(`${name}.${r.name} missing`); continue; }
    if (m.I.typeName !== r.I || m.O.typeName !== r.O || KIND[m.kind] !== r.kind) errors.push(`${name}.${r.name} signature differs`);
  }
  if (gm.size !== rpcs.length) errors.push(`${name}: method count ${rpcs.length} != ${gm.size}`);
}

// wire round-trip with sample values (depth-limited)
const sample = (fi, depth) => {
  const scalar = (T) => ({ 1: 1.5, 2: 2.5, 3: 3n, 4: 4n, 5: -5, 6: 6n, 7: 7, 8: true, 9: "s", 12: new Uint8Array([1, 2]), 13: 13, 15: -15, 16: -16n, 17: -17, 18: -18n })[T];
  if (fi.kind === "scalar") return scalar(fi.T);
  if (fi.kind === "enum") return fi.T.values.at(-1)?.no ?? 0;
  if (fi.kind === "message") return depth > 0 ? build(fi.T, depth - 1) : new fi.T();
  if (fi.kind === "map") return { [fi.K === 9 ? "k" : fi.K === 8 ? "true" : "1"]: fi.V.kind === "scalar" ? scalar(fi.V.T) : fi.V.kind === "enum" ? 0 : new fi.V.T() };
};
const build = (T, depth) => {
  const o = {};
  const seenOneof = new Set();
  for (const fi of T.fields.list()) {
    // well-known types have JSON invariants our generic samples violate; leave them unset
    if ((fi.kind === "message" && fi.T.typeName.startsWith("google.protobuf.")) ||
        (fi.kind === "map" && fi.V.kind === "message" && fi.V.T.typeName.startsWith("google.protobuf."))) continue;
    const v = sample(fi, depth);
    if (fi.oneof) {
      if (seenOneof.has(fi.oneof.name)) continue;
      seenOneof.add(fi.oneof.name);
      o[fi.oneof.localName] = { case: fi.localName, value: v };
    } else o[fi.localName] = fi.repeated && fi.kind !== "map" ? [v] : v;
  }
  return new T(o);
};
for (const [name] of Object.entries(snap.messages)) {
  const T = messages.get(name);
  if (!T) continue;
  try {
    const m = build(T, 2);
    const b1 = m.toBinary();
    const b2 = T.fromBinary(b1).toBinary();
    if (Buffer.compare(Buffer.from(b1), Buffer.from(b2)) !== 0) throw new Error("binary round-trip differs");
    const j = m.toJsonString();
    if (T.fromJsonString(j).toJsonString() !== j) throw new Error("json round-trip differs");
    wireOk++;
  } catch (e) {
    errors.push(`wire ${name}: ${e.message}`);
  }
}
console.log(JSON.stringify({ messages_checked: mChecked, enums_checked: eChecked, rpcs_checked: rpcChecked, wire_roundtrip_ok: wireOk, not_in_generated: skipped.length, errors: errors.length }));
for (const e of errors.slice(0, 50)) console.log("  " + e);
process.exit(errors.length ? 1 : 0);
