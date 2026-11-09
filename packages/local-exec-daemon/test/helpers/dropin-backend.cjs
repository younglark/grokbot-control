'use strict';
// t165 drop-in acceptance: one synthetic backend process-local server that speaks
//  - the generated Connect/proto GrokBotService UC methods (Watch/Poll/Submit/Withdraw) via connectNodeAdapter,
//  - the plain-HTTP connection exchange POST /sand-box/local-exec-connection (D:O9r 179117–179145),
//  - and (on separate listeners) the Box JSON/SSE channel GET /local-exec/requests + POST /local-exec/responses.
// Synthetic data only. Never talks to a real backend.
const http = require('node:http');
const { connectNodeAdapter } = require('@connectrpc/connect-node');
const { ConnectError, Code } = require('@connectrpc/connect');
const { GrokBotService } = require('../../dist/generated/svc_aiserver.v1.GrokBotService_connect');
const pb = require('../../dist/generated/aiserver.v1_pb');

function pairs(rawHeaders) { const o = []; for (let i = 0; i < rawHeaders.length; i += 2) o.push([rawHeaders[i].toLowerCase(), rawHeaders[i + 1]]); return o; }
function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))); }

function startBackend(opts = {}) {
  const t0 = Date.now(); const now = () => Date.now() - t0;
  const log = [];
  const state = { credential: opts.credential, machineId: opts.machineId, queue: [], acked: new Set(), pollAuthFail: 0, watchAuthFail: 0, watchUnavailable: 0, watches: [] };
  const raw = []; // every request's wire header order (rawHeaders), for the mb byte-for-byte check
  const exchange = { reply: null, requests: [] };
  const auth = (req, what) => {
    if (req.credential !== state.credential || req.machineId !== state.machineId) throw new ConnectError(`${what}: bad credential`, Code.Unauthenticated);
  };
  const routes = router => router.service(GrokBotService, {
    async *watchGrokBotUserComputerRequests(req, ctx) {
      const w = { t: now(), credential: req.credential, presenceToken: req.presenceToken, hello: req.hello?.toJson({ emitDefaultValues: true }), headers: Object.fromEntries(ctx.requestHeader), pending: [], wake: null, ended: false };
      state.watches.push(w); log.push({ kind: 'watch', t: w.t, credential: req.credential, hello: w.hello });
      if (state.watchAuthFail > 0) { state.watchAuthFail--; throw new ConnectError('watch: rejected', Code.Unauthenticated); }
      if (state.watchUnavailable > 0) { state.watchUnavailable--; log.push({ kind: 'watch-unavailable', t: now() }); throw new ConnectError('watch: synthetic outage', Code.Unavailable); }
      auth(req, 'watch');
      if (opts.autoConnect !== false) w.pending.push({ case: 'connected', value: {} });
      try {
        for (;;) {
          while (w.pending.length) {
            const ev = w.pending.shift();
            if (ev === 'end') return;
            log.push({ kind: 'event', t: now(), case: ev.case });
            yield new pb.WatchGrokBotUserComputerRequestsEvent({ event: ev });
          }
          await new Promise((resolve, reject) => {
            w.wake = resolve;
            ctx.signal.addEventListener('abort', () => reject(new ConnectError('client went away', Code.Canceled)), { once: true });
          });
        }
      } finally { w.ended = true; log.push({ kind: 'watch-end', t: now() }); }
    },
    async pollGrokBotUserComputerRequests(req) {
      const entry = { kind: 'poll', t: now(), ackIds: [...req.ackIds], limit: req.limit };
      log.push(entry);
      if (state.pollAuthFail > 0) { state.pollAuthFail--; throw new ConnectError('poll: rejected', Code.Unauthenticated); }
      auth(req, 'poll');
      for (const id of req.ackIds) { state.acked.add(id); state.queue = state.queue.filter(q => q.id !== id); }
      return new pb.PollGrokBotUserComputerRequestsResponse({ requests: state.queue.slice(0, req.limit || 64) });
    },
    async submitGrokBotUserComputerResponses(req) {
      auth(req, 'submit');
      const frames = req.frames.map(f => ({ requestId: f.requestId, case: f.frame.case, value: f.frame.value?.toJson ? f.frame.value.toJson({ emitDefaultValues: false }) : f.frame.value }));
      log.push({ kind: 'submit', t: now(), frames });
      return new pb.SubmitGrokBotUserComputerResponsesResponse({ acceptedCount: req.frames.length });
    },
    async withdrawGrokBotUserComputerPresence(req) {
      log.push({ kind: 'withdraw', t: now(), credential: req.credential, presenceToken: req.presenceToken });
      return new pb.WithdrawGrokBotUserComputerPresenceResponse({});
    },
  });
  const connect = connectNodeAdapter({ routes });
  const server = http.createServer((req, res) => {
    raw.push({ t: now(), method: req.method, url: req.url, port: req.socket.remotePort, headers: pairs(req.rawHeaders) });
    if (req.method === 'POST' && req.url === '/sand-box/local-exec-connection') {
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        exchange.requests.push({ t: now(), headers: req.headers, body: JSON.parse(body) });
        log.push({ kind: 'exchange', t: now() });
        const r = exchange.reply ?? { status: 503, body: {} };
        res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body));
      });
      return;
    }
    connect(req, res);
  });
  const api = {
    log, state, exchange, now, raw,
    url: null,
    async listen() { api.url = await listen(server); return api.url; },
    enqueue(id, requestId, frame) { state.queue.push(new pb.GrokBotUserComputerQueuedRequest({ id, frame: new pb.GrokBotUserComputerRequestFrame({ requestId, frame }) })); },
    liveWatch() { return [...state.watches].reverse().find(w => !w.ended); },
    push(ev) { const w = api.liveWatch(); if (!w) return false; w.pending.push(ev); w.wake?.(); return true; },
    notify() { return api.push({ case: 'notify', value: {} }); },
    endWatch() { return api.push('end'); },
    heartbeat(n) { return api.push({ case: 'heartbeat', value: { pendingRequestCount: n } }); },
    submitted(requestId) { return log.filter(x => x.kind === 'submit').flatMap(x => x.frames).filter(f => f.requestId === requestId); },
    close() { server.closeAllConnections?.(); return new Promise(r => server.close(r)); },
  };
  return api;
}

function startBox(opts = {}) {
  const t0 = opts.t0 ?? Date.now(); const now = () => Date.now() - t0;
  const gets = [], posts = []; let stream = null; let status = 200;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      if (req.method === 'GET' && req.url === '/local-exec/requests') {
        gets.push({ t: now(), headers: req.headers, raw: pairs(req.rawHeaders), status });
        if (status !== 200) { res.writeHead(status); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); stream = res;
        res.on('close', () => { if (stream === res) stream = null; });
        return;
      }
      if (req.method === 'POST' && req.url === '/local-exec/responses') {
        const b = JSON.parse(body); posts.push({ t: now(), headers: req.headers, raw: pairs(req.rawHeaders), ...b });
        const slow = opts.pingDelayMs && b.frames.every(f => f.kind === 'ping');
        setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, slow ? opts.pingDelayMs : 0); return;
      }
      res.writeHead(404); res.end();
    });
  });
  const api = {
    gets, posts, url: null,
    async listen() { api.url = await listen(server); return api.url; },
    setStatus(s) { status = s; if (s !== 200 && stream) { stream.end(); stream = null; } },
    connected() { return stream !== null; },
    send(obj) { if (!stream) return false; stream.write('data: ' + JSON.stringify(obj) + '\n\n'); return true; },
    frames(kind) { return posts.flatMap(p => p.frames).filter(f => kind === undefined || f.kind === kind); },
    reply(requestId) { return posts.flatMap(p => p.frames).filter(f => f.requestId === requestId); },
    close() { server.closeAllConnections?.(); return new Promise(r => server.close(r)); },
  };
  return api;
}

module.exports = { startBackend, startBox };
