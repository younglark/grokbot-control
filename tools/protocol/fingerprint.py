#!/usr/bin/env python3
"""Static fingerprint of extracted Grok Bot bundle files: hashes + anchor locations.

Locates the auth / transport / schema entry points by STABLE STRING ANCHORS
(URL paths, protocol literals) instead of drifting line numbers, and prints the
nearest preceding minified function name so you can open the right spot in a
prettified copy. Output contains only code facts; any long opaque identifier
(>= 24 chars of [A-Za-z0-9_-], e.g. a client_id) is replaced by "[opaque:N]".

Reads files only. Never executes bundle code, never uses the network.

Usage:
  fingerprint.py DIR_OR_FILES... [--json]
  e.g. fingerprint.py /tmp/x/dist/electron-main/{main-app,main-core,proto}.cjs
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ANCHORS = {
    "login_url": ["/loginDeepControl"],
    "login_params": ['"redirectTarget"', '"supportsSelectedTeamLogin"'],
    "poll": ["/auth/poll"],
    "api_key_exchange": ["/auth/exchange_user_api_key"],
    "refresh_cursor": ['"/oauth/token"', "grant_type"],
    "refresh_xai": ["/oauth2/token"],
    "policy_error": ["sign_in_policy_violation"],
    "default_backend": ["https://api2.cursor.sh"],
    "default_website": ["https://cursor.com"],
    "client_headers": ["x-cursor-client-type", "x-cursor-client-version", "x-ghost-mode", "x-cursor-team-id"],
    "secrets_store": ["sand-secrets.json"],
    "grokbot_service": ["aiserver.v1.GrokBotService"],
    "sidebar_base": ["sidebar_sections_base", "sidebarSectionsBase"],
}
OPAQUE = re.compile(r"[A-Za-z0-9_-]{24,}")
FUNC = re.compile(r"(?:function\s+([A-Za-z_$][\w$]*)\s*\(|async\s+([A-Za-z_$][\w$]*)\s*\(|([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^()]*\)\s*=>))")


def redact(s: str) -> str:
    return OPAQUE.sub(lambda m: f"[opaque:{len(m.group(0))}]", s)


def nearest_func(text: str, pos: int) -> str:
    window = text[max(0, pos - 4000):pos]
    last = None
    for m in FUNC.finditer(window):
        last = next(g for g in m.groups() if g)
    return last or "?"


def scan(path: Path):
    data = path.read_bytes()
    text = data.decode("utf-8", errors="replace")
    res = {"file": path.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "anchors": {}}
    for cat, pats in ANCHORS.items():
        hits = []
        for p in pats:
            for m in re.finditer(re.escape(p), text):
                ctx = text[max(0, m.start() - 60): m.end() + 60].replace("\n", " ")
                hits.append({"pattern": p, "offset": m.start(), "near_function": nearest_func(text, m.start()), "context": redact(ctx)})
                if len(hits) >= 6:
                    break
        if hits:
            res["anchors"][cat] = hits
    return res


def main(argv):
    as_json = "--json" in argv
    paths = []
    for a in (x for x in argv if x != "--json"):
        p = Path(a)
        paths += sorted(p.glob("*.cjs")) if p.is_dir() else [p]
    if not paths:
        print(__doc__, file=sys.stderr)
        return 2
    out = [scan(p) for p in paths]
    if as_json:
        print(json.dumps(out, indent=1))
        return 0
    for r in out:
        print(f"## {r['file']}  {r['bytes']} bytes  sha256={r['sha256']}")
        for cat, hits in r["anchors"].items():
            print(f"  [{cat}]")
            for h in hits:
                print(f"    {h['pattern']!r} @{h['offset']} fn={h['near_function']} :: {h['context']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
