#!/usr/bin/env python3
"""Compare the protocol surface THIS repo uses between two schema snapshots.

Input snapshots are `snapshot.json` files produced by grokbot-proto's
`scripts/extract_proto.py` (shape: {messages:{fqn:[field]}, enums:{fqn:[value]},
services:{fqn:[{name,I,O,kind}]}}), or the small subset files written by
`--write-subset` (same shape, filtered).

The used RPC set is derived from `client.<method>(` calls under --src, so it
follows the code automatically. Messages are followed transitively from the
request/response types (to --depth levels) so nested types such as
GrokBotSidebarSections are covered.

Classification per field number:
  BREAKING  field removed, name/type/label changed, RPC removed, RPC I/O type changed
  additive  field added, RPC added (not listed: unused RPCs), enum value added
Exit code: 0 no breaking change in used surface, 1 breaking, 2 usage error.

Reads only JSON + TS source text. No network, no bundle execution.

Usage:
  used_surface.py --src packages/grokbot-control/src --old OLD.json --new NEW.json [-o report.md]
  used_surface.py --src packages/grokbot-control/src --new NEW.json --write-subset out.json   # baseline subset
"""
import argparse
import json
import re
import sys
from pathlib import Path

SERVICE = "aiserver.v1.GrokBotService"


def used_rpcs(src: Path):
    names = set()
    for p in src.rglob("*.ts"):
        if "testing" in p.parts:
            continue
        for m in re.finditer(r"client\.([a-z][A-Za-z0-9]+)\(", p.read_text(encoding="utf-8")):
            names.add(m.group(1)[0].upper() + m.group(1)[1:])
    return sorted(names)


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def rpc_map(snap):
    return {r["name"]: r for r in snap.get("services", {}).get(SERVICE, [])}


def field_sig(f):
    t = f.get("T")
    if f.get("kind") == "map":
        t = f"map<{f.get('K')},{f.get('V')}>"
    lab = "repeated " if f.get("repeated") else ("optional " if f.get("opt") else "")
    return f"{lab}{t} {f['name']}"


def collect(snap, roots, depth):
    msgs, enums = set(), set()
    frontier = [r for r in roots if r]
    for _ in range(depth + 1):
        nxt = []
        for t in frontier:
            if t in msgs or t not in snap["messages"]:
                if t in snap.get("enums", {}):
                    enums.add(t)
                continue
            msgs.add(t)
            for f in snap["messages"][t]:
                for ref in (f.get("T"), f.get("V")):
                    if isinstance(ref, str) and "." in ref:
                        nxt.append(ref)
        frontier = nxt
    return msgs, enums


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--old")
    ap.add_argument("--new", required=True)
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("-o")
    ap.add_argument("--write-subset")
    a = ap.parse_args()

    rpcs = used_rpcs(Path(a.src))
    new = load(a.new)
    nmap = rpc_map(new)
    roots = [x for r in rpcs if r in nmap for x in (nmap[r]["I"], nmap[r]["O"])]
    if a.write_subset:
        msgs, enums = collect(new, roots, a.depth)
        sub = {
            "services": {SERVICE: [nmap[r] for r in rpcs if r in nmap]},
            "messages": {m: new["messages"][m] for m in sorted(msgs)},
            "enums": {e: new["enums"][e] for e in sorted(enums)},
        }
        Path(a.write_subset).write_text(json.dumps(sub, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        print(f"subset: {len(sub['services'][SERVICE])} rpcs, {len(msgs)} messages, {len(enums)} enums -> {a.write_subset}")
        if not a.old:
            return 0
    if not a.old:
        ap.error("--old is required unless --write-subset is given")
    old = load(a.old)
    omap = rpc_map(old)
    out, breaking = [], 0
    out.append(f"# Used-surface diff ({SERVICE})\n")
    out.append(f"RPCs used by `{a.src}`: {len(rpcs)}\n")
    for r in rpcs:
        o, n = omap.get(r), nmap.get(r)
        if not n:
            out.append(f"- **BREAKING** RPC `{r}` missing in new snapshot"); breaking += 1; continue
        if not o:
            out.append(f"- note: RPC `{r}` not in old snapshot (new)"); continue
        if (o["I"], o["O"], o["kind"]) != (n["I"], n["O"], n["kind"]):
            out.append(f"- **BREAKING** RPC `{r}` I/O changed {o['I']}->{n['I']} / {o['O']}->{n['O']} / {o['kind']}->{n['kind']}")
            breaking += 1
    oroots = [x for r in rpcs if r in omap for x in (omap[r]["I"], omap[r]["O"])]
    om, oe = collect(old, oroots, a.depth)
    nm, ne = collect(new, roots, a.depth)
    out.append("\n## Messages\n")
    for m in sorted(om | nm):
        of = {f["no"]: f for f in old["messages"].get(m, [])}
        nf = {f["no"]: f for f in new["messages"].get(m, [])}
        if m not in new["messages"]:
            out.append(f"- **BREAKING** `{m}` removed"); breaking += 1; continue
        if m not in old["messages"]:
            out.append(f"- additive `{m}` new type ({len(nf)} fields)"); continue
        lines = []
        for no in sorted(set(of) | set(nf)):
            if no not in nf:
                lines.append(f"  - **BREAKING** -{no}: {field_sig(of[no])}"); breaking += 1
            elif no not in of:
                lines.append(f"  - additive +{no}: {field_sig(nf[no])}")
            elif field_sig(of[no]) != field_sig(nf[no]):
                lines.append(f"  - **BREAKING** ~{no}: {field_sig(of[no])} -> {field_sig(nf[no])}"); breaking += 1
        if lines:
            out.append(f"- `{m}`")
            out.extend(lines)
    out.append("\n## Enums\n")
    for e in sorted(oe | ne):
        ov = {v["no"]: v["name"] for v in old.get("enums", {}).get(e, [])}
        nv = {v["no"]: v["name"] for v in new.get("enums", {}).get(e, [])}
        for no in sorted(set(ov) | set(nv)):
            if no not in nv:
                out.append(f"- **BREAKING** `{e}` value {no} {ov[no]} removed"); breaking += 1
            elif no not in ov:
                out.append(f"- additive `{e}` +{no} {nv[no]}")
            elif ov[no] != nv[no]:
                out.append(f"- **BREAKING** `{e}` {no}: {ov[no]} -> {nv[no]}"); breaking += 1
    out.append(f"\n**Summary:** {breaking} breaking change(s) in the used surface.\n")
    text = "\n".join(out) + "\n"
    if a.o:
        Path(a.o).write_text(text, encoding="utf-8")
    sys.stdout.write(text if not a.o else f"breaking={breaking} report={a.o}\n")
    return 1 if breaking else 0


if __name__ == "__main__":
    sys.exit(main())
