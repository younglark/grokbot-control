import * as fs from "node:fs";
import * as path from "node:path";
export class PathGuardError extends Error {
  constructor(message: string) { super(message); this.name = "SandLocalExecPathError"; }
}
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}
export function assertUnderRoot(root: string, target: string): string {
  const base = path.resolve(root), abs = path.resolve(base, target);
  if (!inside(base, abs)) throw new PathGuardError(`Path is outside the allowed local-exec root and was refused: ${abs}`);
  return abs;
}
export function assertRealpathUnderRoot(root: string, target: string): string {
  const abs = assertUnderRoot(root, target);
  const realRoot = fs.realpathSync(root);
  let parent = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(parent);
      if (!inside(realRoot, real)) throw new PathGuardError(`Path resolves through a symlink to outside the allowed local-exec root and was refused: ${abs}`);
      return abs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const up = path.dirname(parent);
      if (up === parent) throw e;
      parent = up;
    }
  }
}
