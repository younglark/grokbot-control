'use strict';
// t168: synthetic ~/.claude + ~/.codex trees (fake secrets only) and the output the ORIGINAL VJe would produce for them,
// derived by hand from daemon.formatted.cjs 0.79.3 (never by running it):
//  VJe 97585, qJe 97606, _Ht 97627, KJe 97644 (dedupe kind\ntitle, config ≤ mHt 24, history desc fills $pe 40),
//  GJe/yHt 97657–97672 (excerpt "stdio · basename" | type | "http" | "unknown"), AHt 97680 (config.toml scan),
//  ZJe 97705 (skills/*/SKILL.md), jpe 97716 (commands maxDepth 2 → "a:b:c" via mJe; prompts maxDepth 0),
//  QJe 97743 (.jsonl count, depth ≤ 2 claude / ≤ 4 codex, newest mtime), rqe 97818 (256 KiB tail),
//  WJe/SHt/gHt 97583–97584 (drop "/cmd", strip [Pasted text #n]/[Image #n]), RHt (s→ms if < 1e12),
//  bp 97102 (9 secret regexes → [redacted], [link], [email], [path], 160 chars with "…").
const fs = require('node:fs'), path = require('node:path');
const w = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const at = (f, ms) => fs.utimesSync(f, ms / 1000, ms / 1000);

function buildClaude(home) {
  w(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { github: { command: '/usr/local/bin/gh-mcp', args: ['--x'] }, remote: { url: 'https://mcp.example.invalid/sse', type: 'sse' } },
    projects: { '/p/a': { mcpServers: { local: { url: 'http://localhost:1' }, github: { command: 'npx' } } }, '/p/b': 'not-an-object' },
  }));
  const c = path.join(home, '.claude');
  w(path.join(c, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'superpowers@market': {}, 'sk-ABCDEFGHIJKLMNOPQRST': {} } }));
  w(path.join(c, 'skills', 'alpha', 'SKILL.md'), '# alpha');
  fs.mkdirSync(path.join(c, 'skills', 'beta'), { recursive: true }); // no SKILL.md → not a skill
  w(path.join(c, 'commands', 'deploy.md'), 'x');
  w(path.join(c, 'commands', 'ns', 'sub.md'), 'x');
  w(path.join(c, 'commands', 'ns', 'deeper', 'x.md'), 'x');
  w(path.join(c, 'commands', 'ns', 'deeper', 'more', 'y.md'), 'x'); // beyond maxDepth 2
  w(path.join(c, 'commands', 'notes.txt'), 'x');
  const s1 = path.join(c, 'projects', 'p1', 's1.jsonl'), s2 = path.join(c, 'projects', 'p1', 's2.jsonl'), s3 = path.join(c, 'projects', 'p2', 'deep', 's3.jsonl');
  for (const f of [s1, s2, s3]) w(f, '{}\n');
  w(path.join(c, 'projects', 'p2', 'deep', 'deeper', 's4.jsonl'), '{}\n'); // depth 3 → not counted
  w(path.join(c, 'projects', 'p1', 'notes.txt'), 'x');
  at(s1, 1700000000000); at(s2, 1700000100000); at(s3, 1700000200500);
  const H = [
    { display: 'fix the bug in /home/user/project/src/main.ts please', timestamp: 1700000300000 },
    { display: '/clear', timestamp: 1700000301000 },
    { display: 'use key sk-abcdefghijklmnop1234 and email bob@example.com see https://ex.com/a?b=1', timestamp: 1700000302000 },
    { display: '[Pasted text #1 +20 lines] summarize', timestamp: 1700000303000 },
    { display: 'token=ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 end', timestamp: 1700000304000 },
    { display: 'Bearer abcdefghijklmnopqrstuvwxyz', timestamp: 1700000305000 },
    { display: 'x'.repeat(200), timestamp: 1700000306000 },
    { display: 'fix the bug in /home/user/project/src/main.ts please', timestamp: 1700000307000 },
    'not json',
    { display: 123 },
    { display: 'no   timestamp\there' },
  ];
  w(path.join(c, 'history.jsonl'), H.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') + '\n');
}
const EXPECTED_CLAUDE = {
  source: 'claude_code', found: true, sessionCount: 7, lastActiveAtMs: 1700000306000,
  items: [
    { kind: 'mcp_server', title: 'github', excerpt: 'stdio · gh-mcp' },
    { kind: 'mcp_server', title: 'remote', excerpt: 'sse' },
    { kind: 'mcp_server', title: 'local', excerpt: 'http' },
    { kind: 'plugin', title: 'superpowers@market' },
    { kind: 'plugin', title: '[redacted]' },
    { kind: 'skill', title: 'alpha' },
    { kind: 'skill', title: 'deploy' },
    { kind: 'skill', title: 'ns:deeper:x' },
    { kind: 'skill', title: 'ns:sub' },
    { kind: 'session', title: 'x'.repeat(159) + '\u2026', occurredAtMs: 1700000306000 },
    { kind: 'session', title: '[redacted]', occurredAtMs: 1700000305000 },
    { kind: 'session', title: 'token=[redacted] end', occurredAtMs: 1700000304000 },
    { kind: 'session', title: 'summarize', occurredAtMs: 1700000303000 },
    { kind: 'session', title: 'use key [redacted] and email [email] see [link]', occurredAtMs: 1700000302000 },
    { kind: 'session', title: 'fix the bug in [path] please', occurredAtMs: 1700000300000 },
    { kind: 'session', title: 'no timestamp here' },
  ],
};

function buildCodex(home) {
  const c = path.join(home, '.codex');
  w(path.join(c, 'config.toml'), [
    '[mcp_servers.fs]', 'command = "/opt/bin/fs-server"', 'args = ["a"]', '',
    '[mcp_servers."web search"]', 'url = "https://search.example.invalid/mcp"', '',
    '[mcp_servers.fs.env]', 'API_KEY = "sk-shouldneverappear0000000"', 'command = "/bin/not-this"', '',
    '[mcp_servers.bare]', '', '[other]', 'command = "ignored"', ''].join('\n'));
  w(path.join(c, 'skills', 'gamma', 'SKILL.md'), '# g');
  w(path.join(c, 'prompts', 'p1.md'), 'x');
  w(path.join(c, 'prompts', 'sub', 'p2.md'), 'x'); // maxDepth 0
  const r1 = path.join(c, 'sessions', '2026', '11', '09', 'rollout-1.jsonl'), r2 = path.join(c, 'sessions', 'a', 'b', 'c', 'd', 'y.jsonl');
  w(r1, '{}\n'); w(r2, '{}\n');
  w(path.join(c, 'sessions', 'a', 'b', 'c', 'd', 'e', 'x.jsonl'), '{}\n'); // depth 5 → not counted
  at(r1, 1690000000000); at(r2, 1690000001000);
  w(path.join(c, 'history.jsonl'), [JSON.stringify({ text: 'hello codex', ts: 1700000400 }), JSON.stringify({ text: 'ghp_ABCDEFGHIJKLMNOPQRSTUV token', ts: 1700000401000 })].join('\n') + '\n');
}
const EXPECTED_CODEX = {
  source: 'codex', found: true, sessionCount: 2, lastActiveAtMs: 1700000401000,
  items: [
    { kind: 'mcp_server', title: 'fs', excerpt: 'stdio · fs-server' },
    { kind: 'mcp_server', title: 'web search', excerpt: 'http' },
    { kind: 'mcp_server', title: 'bare', excerpt: 'unknown' },
    { kind: 'skill', title: 'gamma' },
    { kind: 'skill', title: 'p1' },
    { kind: 'session', title: '[redacted] token', occurredAtMs: 1700000401000 },
    { kind: 'session', title: 'hello codex', occurredAtMs: 1700000400000 },
  ],
};
const NOT_FOUND = s => ({ source: s, found: false, sessionCount: 0, items: [] }); // Fpe 97081

module.exports = { buildClaude, buildCodex, EXPECTED_CLAUDE, EXPECTED_CODEX, NOT_FOUND };
