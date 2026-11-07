"""Offline tests for tools/protocol (stdlib unittest). Run: python3 -m unittest discover -s tools/protocol"""
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable


def make_asar(path: Path, files: dict):
    hdr, blob, off = {"files": {}}, b"", 0
    for name, data in files.items():
        node = hdr
        parts = name.split("/")
        for d in parts[:-1]:
            node = node["files"].setdefault(d, {"files": {}})
        node["files"][parts[-1]] = {"size": len(data), "offset": str(off)}
        blob += data
        off += len(data)
    j = json.dumps(hdr).encode()
    pad = (4 - len(j) % 4) % 4
    pickle = struct.pack("<II", len(j) + 4 + pad, len(j)) + j + b"\0" * pad
    path.write_bytes(struct.pack("<II", 4, len(pickle)) + pickle + blob)


def run(*args):
    return subprocess.run([PY, *map(str, args)], capture_output=True, text=True)


class AsarTests(unittest.TestCase):
    def test_list_extract_and_refusals(self):
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as out:
            asar = Path(src) / "app.asar"
            make_asar(asar, {"dist/electron-main/proto.cjs": b"PROTO", "package.json": b"{}"})
            r = run(HERE / "asar_extract.py", "list", asar)
            self.assertIn("dist/electron-main/proto.cjs", r.stdout)
            r = run(HERE / "asar_extract.py", "extract", asar, out, "dist/electron-main/proto.cjs")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual((Path(out) / "dist/electron-main/proto.cjs").read_bytes(), b"PROTO")
            self.assertNotEqual(run(HERE / "asar_extract.py", "extract", asar, out, "../x").returncode, 0)
            self.assertNotEqual(run(HERE / "asar_extract.py", "extract", asar, Path(src) / "o", "package.json").returncode, 0)


class FingerprintTests(unittest.TestCase):
    def test_anchor_and_redaction(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "main-app.cjs"
            f.write_text('function Rdn(e){let l=new URL("/loginDeepControl",t);var cid="ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";fetch(`${n}/auth/poll`)}')
            r = run(HERE / "fingerprint.py", f, "--json")
            res = json.loads(r.stdout)[0]
            self.assertEqual(res["anchors"]["login_url"][0]["near_function"], "Rdn")
            self.assertIn("poll", res["anchors"])
            self.assertNotIn("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", r.stdout)


class UsedSurfaceTests(unittest.TestCase):
    def snap(self, fields, rpc_in="aiserver.v1.FooRequest"):
        return {
            "services": {"aiserver.v1.GrokBotService": [{"name": "ListFoo", "I": rpc_in, "O": "aiserver.v1.FooResponse", "kind": "Unary"}]},
            "messages": {"aiserver.v1.FooRequest": fields, "aiserver.v1.FooResponse": []},
            "enums": {},
        }

    def check(self, old, new):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            src.mkdir()
            (src / "a.ts").write_text("await this.client.listFoo({});")
            (Path(d) / "o.json").write_text(json.dumps(old))
            (Path(d) / "n.json").write_text(json.dumps(new))
            return run(HERE / "used_surface.py", "--src", src, "--old", Path(d) / "o.json", "--new", Path(d) / "n.json")

    F1 = {"no": 1, "name": "agent_id", "kind": "scalar", "T": "string"}

    def test_additive_ok(self):
        r = self.check(self.snap([self.F1]), self.snap([self.F1, {"no": 2, "name": "x", "kind": "scalar", "T": "bool", "opt": True}]))
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("additive +2", r.stdout)

    def test_removed_or_retyped_is_breaking(self):
        self.assertEqual(self.check(self.snap([self.F1]), self.snap([])).returncode, 1)
        r = self.check(self.snap([self.F1]), self.snap([{**self.F1, "T": "int64"}]))
        self.assertEqual(r.returncode, 1)
        self.assertIn("BREAKING", r.stdout)

    def test_rpc_removed_is_breaking(self):
        new = self.snap([self.F1])
        new["services"]["aiserver.v1.GrokBotService"] = []
        self.assertEqual(self.check(self.snap([self.F1]), new).returncode, 1)


if __name__ == "__main__":
    unittest.main()
