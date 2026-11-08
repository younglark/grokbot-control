#!/usr/bin/env python3
"""Explicit opt-in, two fixed scenarios, no network/filesystem isolation fallback."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

OFFICIAL_SHA256 = "5c1424ed3784704abbb20e83ced15ab8ebd161ddef5e7f1a74eed374453d36be"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--official", action="store_true", help="OPT IN to unmodified official 0.79.3")
    mode.add_argument("--implementation", action="store_true", help="explicitly run built independent daemon")
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--input-dir", required=True, type=Path, help="read-only runtime inputs containing artifact; official also needs its node_modules")
    parser.add_argument("--node", required=True, type=Path, help="explicit compatible Node executable")
    parser.add_argument("--node-modules", type=Path, help="implementation dependencies mounted at /node_modules")
    parser.add_argument("--out", required=True, type=Path, help="NEW output directory, never reused")
    args = parser.parse_args()
    artifact, inputs, node = args.artifact.resolve(strict=True), args.input_dir.resolve(strict=True), args.node.resolve(strict=True)
    entry = "main.cjs" if args.official else "index.js"
    mounted = inputs / entry
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    if not artifact.is_file() or not mounted.is_file() or digest(artifact) != digest(mounted):
        parser.error("artifact must match input-dir's selected entry byte-for-byte")
    if args.official and digest(artifact) != OFFICIAL_SHA256:
        parser.error("official artifact SHA256 is not the approved 0.79.3 identity")
    if args.official and not (inputs / "node_modules").is_dir():
        parser.error("official runtime dependencies must already exist in input-dir/node_modules")
    if args.implementation and (not args.node_modules or not args.node_modules.is_dir()):
        parser.error("implementation requires explicit --node-modules")
    if not os.access(node, os.X_OK):
        parser.error("Node must be executable")
    output = args.out.absolute()
    output.mkdir(parents=True, exist_ok=False)
    state, evidence = output / "state", output / "evidence"
    state.mkdir(); evidence.mkdir()
    scripts = Path(__file__).resolve().parent
    command = ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session",
        "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
        "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--bind", str(state), "/state", "--dir", "/runtime", "--ro-bind", str(node), "/runtime/node",
        "--ro-bind", str(scripts), "/scripts", "--bind", str(evidence), "/out"]
    if args.official:
        command += ["--tmpfs", "/input", "--ro-bind", str(artifact), "/input/main.cjs",
                    "--ro-bind", str(inputs / "node_modules"), "/input/node_modules"]
    else:
        command += ["--ro-bind", str(inputs), "/input"]
    if args.implementation:
        command += ["--ro-bind", str(args.node_modules.resolve(strict=True)), "/node_modules"]
    command += ["--clearenv", "--setenv", "PATH", "/runtime:/usr/bin:/bin", "--chdir", "/state",
                "/runtime/node", "/scripts/run.cjs", "official" if args.official else "implementation"]
    (output / "command.json").write_text(json.dumps(command, indent=2) + "\n")
    (output / "identity.json").write_text(json.dumps({"artifactSha256": digest(artifact), "nodeSha256": digest(node), "mode": "official" if args.official else "implementation"}, indent=2) + "\n")
    process = None
    try:
        with (output / "stdout.log").open("wb") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            try:
                code = process.wait(timeout=130)
            except subprocess.TimeoutExpired:
                (output / "deadline.log").write_text("130s total limit; no retry or isolation fallback\n")
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
                code = 124
    finally:
        if process is not None and process.poll() is None:
            process.kill(); process.wait()
        # Only our newly created synthetic HOME/data/root, not logs or inputs.
        shutil.rmtree(state)
    (output / "launcher-result.json").write_text(json.dumps({"exitCode": code, "namespaceExited": True, "syntheticStateRemoved": True}) + "\n")
    return code

if __name__ == "__main__":
    raise SystemExit(main())
