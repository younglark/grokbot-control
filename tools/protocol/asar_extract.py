#!/usr/bin/env python3
"""Read-only Electron ASAR reader: list or copy selected files out of app.asar.

Pure Python stdlib. Never executes bundle code, never touches the network,
never writes into the source directory. Refuses absolute/".." member paths.

Usage:
  asar_extract.py list  APP_ASAR [--grep REGEX]
  asar_extract.py extract APP_ASAR OUT_DIR MEMBER [MEMBER ...]
      e.g. MEMBER = dist/electron-main/proto.cjs

ASAR layout (Electron): [u32 4][u32 header_pickle_size][pickle: u32 payload][u32 json_len][json]
file offsets are relative to 8 + header_pickle_size. Members flagged "unpacked"
live in APP_ASAR + ".unpacked/" and are copied from there.
"""
import json
import os
import re
import struct
import sys


def read_header(path):
    with open(path, "rb") as f:
        head = f.read(16)
        if len(head) < 16:
            raise SystemExit("not an asar (too short)")
        _four, hsize, _payload, jlen = struct.unpack("<IIII", head)
        hdr = json.loads(f.read(jlen).decode("utf-8"))
    return hdr, 8 + hsize


def walk(node, prefix=""):
    for name, child in node.get("files", {}).items():
        p = f"{prefix}{name}"
        if "files" in child:
            yield from walk(child, p + "/")
        else:
            yield p, child


def safe_member(m):
    if m.startswith("/") or ".." in m.split("/"):
        raise SystemExit(f"refusing unsafe member path: {m}")
    return m


def main(argv):
    if len(argv) < 2 or argv[0] not in ("list", "extract"):
        print(__doc__, file=sys.stderr)
        return 2
    asar = argv[1]
    hdr, base = read_header(asar)
    entries = dict(walk(hdr))
    if argv[0] == "list":
        rx = None
        if "--grep" in argv:
            rx = re.compile(argv[argv.index("--grep") + 1])
        for p, e in sorted(entries.items()):
            if rx is None or rx.search(p):
                print(f"{e.get('size', 0)}\t{p}")
        return 0
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    out = os.path.abspath(argv[2])
    src_dir = os.path.dirname(os.path.abspath(asar))
    if os.path.commonpath([out, src_dir]) == src_dir:
        raise SystemExit("refusing to write inside the source directory")
    for m in map(safe_member, argv[3:]):
        e = entries.get(m)
        if e is None:
            raise SystemExit(f"member not found: {m}")
        dst = os.path.join(out, m)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if e.get("unpacked"):
            with open(os.path.join(asar + ".unpacked", m), "rb") as s:
                data = s.read()
        else:
            with open(asar, "rb") as f:
                f.seek(base + int(e["offset"]))
                data = f.read(int(e["size"]))
        with open(dst, "wb") as d:
            d.write(data)
        print(f"{len(data)}\t{m}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
