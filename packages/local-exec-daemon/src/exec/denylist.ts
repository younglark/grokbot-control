/**
 * Admin command denylist (Qk / vhe / zje / hZt / ZE / fZt) and shell command parsing (m3 / GYt).
 * D:106650–106796 (Qk), D:99470–99750 (parser), D:6502–6535 / 13529 (Mg/lse/bb/R4).
 * tree-sitter / tree-sitter-bash from package.json; when natives unavailable → parsingFailed → fail-closed fZt (exact original).
 */
import { createRequire } from "node:module";

export type ExecutableCommand = { name: string; args: { type: string; value: string }[]; fullText: string };
export type ParsingResult = {
  parsingFailed: boolean;
  executableCommands: ExecutableCommand[];
  hasRedirects: boolean;
  hasCommandSubstitution: boolean;
  redirects: unknown[];
};

const FAIL_CLOSED =
  "Denied: this command could not be conclusively analyzed against your team's administrator command denylist, so it was blocked (fail-closed) and was not executed. It cannot be approved from this conversation; only a user can run it manually outside the agent. You may continue working on the task.";

export function denylistDeniedReason(rule: string): string {
  // D:ZE 106783–106785
  return `Denied: this command was blocked by administrator policy (denylist rule: ${rule}) and was not executed. It cannot be approved from this conversation; only a user can run it manually outside the agent. You may continue working on the task.`;
}

export const DENYLIST_PARSE_FAILED_REASON = FAIL_CLOSED;

function aTt(t: string): boolean {
  return t === " " || t === "\t" || t === "\n" || t === "\r" || t === "\u00A0";
}
/** D:Mg 6502 — collapse unicode whitespace runs to a single ASCII space. */
export function Mg(t: string): string {
  let e = "", r = false;
  for (const n of t) {
    if (aTt(n)) { r = true; continue; }
    if (r && e.length > 0) e += " ";
    r = false; e += n;
  }
  return e;
}
function use(t: string): boolean {
  if (t.length === 0) return false;
  for (let e = 0; e < t.length; e++) if (t[e] !== "*") return false;
  return true;
}
/** D:bb 6535 — `exe:args` rule split. */
export function bb(t: string): { executablePattern: string; argsPattern: string } | undefined {
  const e = t.indexOf(":");
  if (e <= 0) return;
  const r = t.slice(0, e).trim();
  for (let n = 0; n < r.length; n++) {
    const s = r[n];
    if (s !== undefined && s.trim().length === 0) return;
  }
  return { executablePattern: r, argsPattern: t.slice(e + 1).trim() };
}
/** D:lse 6514 — invalid catch-all rules. */
export function lse(t: string): string | null {
  const e = Mg(t).trim();
  if (e.length === 0) return "Rule cannot be empty";
  if (e.length > 512) return "Rule cannot exceed 512 characters";
  if (use(e)) return "Rule cannot match every command; be more specific than wildcards alone";
  if (e.startsWith(":")) return "Colon rules need an executable before `:` (e.g. `aws:*s3 rm*`)";
  const r = bb(e);
  if (r !== undefined) {
    const { executablePattern: n, argsPattern: s } = r;
    if (use(n) && (s.length === 0 || use(s)))
      return "Rule cannot match every command; narrow the executable or argument pattern";
  }
  return null;
}
function ALt(t: string): string { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function TLt(t: string): { trimmedPattern: string; regexSource: string } {
  const e = t.trim(), r = ALt(e);
  return { trimmedPattern: e, regexSource: `^${r.replace(/\\\*/g, ".*")}$` };
}
/** D:R4 13529 — glob match (* → .*). */
export function R4(t: string, e: string): boolean {
  const { trimmedPattern: r, regexSource: n } = TLt(t);
  try { return new RegExp(n).test(e); } catch { return r === e; }
}
/** D:hZt 106758 — rule vs one command form. */
export function hZt(t: string, e: string): boolean {
  const r = bb(t);
  if (r !== undefined) {
    const { executablePattern: n, argsPattern: s } = r;
    const o = e.indexOf(" ");
    const i = o === -1 ? e : e.slice(0, o);
    const a = o === -1 ? "" : e.slice(o + 1).trim();
    if (R4(n, i) && R4(s, a)) return true;
  }
  return t.includes("*") ? R4(t, e) : e === t || e.startsWith(`${t} `);
}

const pZt: Record<string, string> = {
  a: "\x07", b: "\b", e: "\x1B", E: "\x1B", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
};
/** D:mZt 106671 — ANSI-C / quote unescaping for denylist forms. */
export function mZt(t: string): string {
  let e = "", r: "plain" | "ansi" | "single" | "double" = "plain", n = 0;
  while (n < t.length) {
    const s = t[n]!;
    if (r === "plain") {
      if (s === "$" && t[n + 1] === "'") { r = "ansi"; n += 2; }
      else if (s === "$" && t[n + 1] === '"') { r = "double"; n += 2; }
      else if (s === "'") { r = "single"; n++; }
      else if (s === '"') { r = "double"; n++; }
      else if (s === "\\" && n + 1 < t.length) { if (t[n + 1] !== "\n") e += t[n + 1]; n += 2; }
      else { e += s; n++; }
      continue;
    }
    if (r === "single") { if (s === "'") r = "plain"; else e += s; n++; continue; }
    if (r === "double") {
      if (s === '"') { r = "plain"; n++; continue; }
      if (s === "\\" && n + 1 < t.length) {
        const d = t[n + 1]!;
        if (d === "$" || d === "`" || d === '"' || d === "\\" || d === "\n") {
          if (d !== "\n") e += d; n += 2; continue;
        }
      }
      e += s; n++; continue;
    }
    // ansi
    if (s === "'") { r = "plain"; n++; continue; }
    if (s !== "\\" || n + 1 >= t.length) { e += s; n++; continue; }
    const o = t[n + 1]!;
    const i = pZt[o];
    if (i !== undefined) { e += i; n += 2; continue; }
    const a = o === "x" ? t.slice(n + 2).match(/^[0-9a-fA-F]{1,2}/)?.[0]
      : o === "u" ? t.slice(n + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0]
      : o === "U" ? t.slice(n + 2).match(/^[0-9a-fA-F]{1,8}/)?.[0]
      : t.slice(n + 1).match(/^[0-7]{1,3}/)?.[0];
    const u = o === "u" || o === "U";
    const l = o === "x" || u ? 16 : 8;
    if (a !== undefined) {
      const d = Number.parseInt(a, l);
      if (!u || d <= 0x10FFFF) {
        e += u ? String.fromCodePoint(d) : String.fromCharCode(d);
        n += a.length + (l === 16 ? 2 : 1);
        continue;
      }
    }
    e += o; n += 2;
  }
  return Mg(e);
}

/** D:zje 106742 — one rule against one command form. Invalid rules (lse) always "match" (block). */
export function zje({ rule, command }: { rule: string; command: string }): boolean {
  const r = Mg(rule).trim();
  if (r.length === 0) return false;
  if (lse(r) !== null) return true;
  return [command.trim(), Mg(command).trim(), mZt(command).trim()].some(n => hZt(r, n));
}

/** D:vhe 106769 — first matching rule, or undefined. */
export function vhe({ matchForms, blockedCommands }: { matchForms: string[]; blockedCommands: string[] }): string | undefined {
  const r = blockedCommands.map(o => o.trim()).filter(o => o.length > 0);
  if (r.length === 0) return;
  const n = matchForms.map(o => o.trim()).filter(o => o.length > 0);
  const s = n.length > 0 ? n : [""];
  for (const o of r) if (s.some(i => zje({ rule: o, command: i }))) return o;
}

/** D:Gje 106652 — full command + each executableCommands.fullText. */
export function Gje({ command, parsingResult }: { command: string; parsingResult: ParsingResult }): string[] {
  return [...new Set([command, ...parsingResult.executableCommands.map(r => r.fullText)])];
}

/** D:Qk 106788 — empty denylist → allow; parse fail → fZt; else ZE(matched rule). */
export function Qk({ command, parsingResult, blockedCommands }: {
  command: string; parsingResult: ParsingResult; blockedCommands: string[];
}): string | undefined {
  if (blockedCommands.length === 0) return;
  if (parsingResult.parsingFailed || parsingResult.executableCommands.length === 0) return FAIL_CLOSED;
  const n = vhe({ matchForms: Gje({ command, parsingResult }), blockedCommands });
  return n === undefined ? undefined : denylistDeniedReason(n);
}

// --- tree-sitter shell parse (D:GYt / m3) — only what Qk needs: executableCommands + parsingFailed ---

type ParserLike = { setLanguage(lang: unknown): void; parse(src: string): { rootNode: TsNode } };
type TsNode = {
  type: string; text: string; children: TsNode[]; namedChildren: TsNode[];
  childForFieldName(name: string): TsNode | null; firstNamedChild: TsNode | null; parent: TsNode | null;
};

/** Resolve via package.json dependencies only (tree-sitter@0.21.1, tree-sitter-bash@0.21.0).
 * No App/exec-daemon path fallbacks — natives come from npm rebuild. */
function loadParserFactory(): (() => ParserLike | null) | null {
  const req = createRequire(__filename);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Parser = req("tree-sitter");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Bash = req("tree-sitter-bash");
    const lang = Bash.default ?? Bash;
    return () => {
      try {
        const p = new Parser() as ParserLike;
        p.setLanguage(lang);
        return p;
      } catch (n) {
        if (typeof n === "object" && n && (n as { code?: string }).code === "CURSOR_TREE_SITTER_STUBBED") return null;
        throw n;
      }
    };
  } catch {
    return null;
  }
}

let parserFactory: (() => ParserLike | null) | null | undefined;
let cachedParser: ParserLike | null | undefined;
function getParser(): ParserLike | null {
  if (parserFactory === undefined) parserFactory = loadParserFactory();
  if (parserFactory === null) return null;
  if (cachedParser !== undefined) return cachedParser;
  try {
    cachedParser = parserFactory();
    if (cachedParser === null) {
      console.warn("shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed");
    }
  } catch (n) {
    if (typeof n === "object" && n && (n as { code?: string }).code === "CURSOR_TREE_SITTER_STUBBED") {
      cachedParser = null;
      console.warn("shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed");
    } else throw n;
  }
  return cachedParser ?? null;
}

function fieldChildren(node: TsNode, field: string): TsNode[] {
  // tree-sitter node walk for field — approximate via named children + childForFieldName for "name"
  if (field === "name") {
    const n = node.childForFieldName("name");
    return n ? [n] : [];
  }
  if (field === "argument") {
    // Walk children; tree-sitter-bash marks arguments with field name. Use cursor if available.
    const out: TsNode[] = [];
    const walk = (node as unknown as { walk?: () => { gotoFirstChild(): boolean; gotoNextSibling(): boolean; currentFieldName: string | null; currentNode: TsNode } }).walk;
    if (typeof walk === "function") {
      const c = walk.call(node);
      if (c.gotoFirstChild()) {
        do { if (c.currentFieldName === field) out.push(c.currentNode); } while (c.gotoNextSibling());
      }
      return out;
    }
    // Fallback: every named child after name
    const name = node.childForFieldName("name");
    let seen = !name;
    for (const ch of node.namedChildren) {
      if (!seen) { if (ch === name) seen = true; continue; }
      out.push(ch);
    }
    return out;
  }
  return [];
}

/** D:GYt subset — collect executableCommands / parsingFailed (redirect bookkeeping omitted for Qk). */
export function parseShellCommand(command: string): ParsingResult {
  const parser = getParser();
  if (parser === null) {
    return { parsingFailed: true, executableCommands: [], hasRedirects: false, hasCommandSubstitution: false, redirects: [] };
  }
  const tree = parser.parse(command);
  const a: ParsingResult = { parsingFailed: false, executableCommands: [], hasRedirects: false, hasCommandSubstitution: false, redirects: [] };
  function visit(v: TsNode): void {
    if (v.type === "command") {
      const N = v.childForFieldName("name");
      if (N === null) a.parsingFailed = true;
      else {
        let D = N.text;
        const P: { type: string; value: string }[] = [];
        for (const O of fieldChildren(v, "argument")) {
          P.push({ type: O.type, value: O.text });
          D += ` ${O.text}`;
        }
        a.executableCommands.push({ name: N.text, args: P, fullText: D });
      }
    }
    if (v.type === "command_substitution" || v.type === "process_substitution") a.hasCommandSubstitution = true;
    for (const N of v.children) visit(N);
  }
  visit(tree.rootNode);
  return a;
}

/** D:m3 → structured only. */
export function m3Structured(command: string): ParsingResult {
  return parseShellCommand(command);
}
