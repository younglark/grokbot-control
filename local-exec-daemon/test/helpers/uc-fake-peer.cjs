'use strict';
const http = require('node:http');
const pb = require('./wire-oracle.cjs');

const SYN_CRED = 'synthetic-uc-credential-lab-only';
const SYN_MACHINE = 'synthetic-lab-machine';

function buildConnected(pending = 0) {
  return pb.encMsg(1, pb.encVarint(1, pending));
}
function buildNotify() {
  return pb.encMsg(2, Buffer.alloc(0));
}
function buildExecFrame(requestId, serverMessage) {
  const exec = pb.encStr(1, JSON.stringify(serverMessage));
  return Buffer.concat([pb.encStr(1, requestId), pb.encMsg(2, exec)]);
}
function buildQueued(id, frameBuf, at = Date.now()) {
  return Buffer.concat([pb.encStr(1, id), pb.encMsg(2, frameBuf), pb.encInt64(3, at)]);
}
function buildPollResponse(queuedList) {
  return Buffer.concat(queuedList.map((q) => pb.encMsg(1, q)));
}
function buildSubmitAccepted(n) {
  return pb.encVarint(1, n);
}
function buildWithdrawn(v = true) {
  return pb.encBool(1, v);
}

function startUcFakePeer(opts = {}) {
  const synCred = opts.credential || SYN_CRED;
  const synMachine = opts.machineId || SYN_MACHINE;
  const log = [];
  let queue = [];
  let watchRes = null;
  let forceUnauth = false;
  let submitUnauth = false;
  let submitFailures = 0;
  let acceptedOverride;
  const acceptedByRequest = new Map();
  const watches = new Set();

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = url.includes("WatchGrokBot") ? pb.takeEnvelopes(raw).messages[0] : raw;
      try {
        if (url.includes('WatchGrokBotUserComputerRequests')) {
          res.writeHead(200, {
            'content-type': 'application/connect+proto',
            'connect-content-encoding': 'identity',
          });
          const fields = pb.decodeFields(body);
          const machineId = pb.firstStr(fields, 1);
          const credential = pb.firstStr(fields, 2);
          const presence = pb.firstStr(fields, 4);
          let hello = {};
          if (fields[3]?.[0]?.t === 'b') {
            const hf = pb.decodeFields(fields[3][0].v);
            hello = {
              label: pb.firstStr(hf, 1),
              localRoot: pb.firstStr(hf, 2),
              terminalsFolder: pb.firstStr(hf, 3),
              standing: pb.firstStr(hf, 4),
              supervised: !!(hf[5]?.[0]?.v),
              variant: pb.firstStr(hf, 6),
              serverAuthoritative: !!(hf[7]?.[0]?.v),
              kind: pb.firstStr(hf,9),
            };
            if (hf[8]?.[0]?.t === 'b') {
              const cf = pb.decodeFields(hf[8][0].v);
              hello.capabilities = {
                messagesOpGeneration: cf[2]?.[0]?.v,
                aiToolSetup: !!(cf[4]?.[0]?.v),
              };
            }
          }
          log.push({ kind: 'watch', machineId, credentialLen: credential.length, presenceLen: presence.length, presence, hello, helloHex: fields[3]?.[0]?.v.toString('hex') });
          if (forceUnauth || credential !== (opts.credential || synCred) || machineId !== synMachine) {
            res.write(pb.endEnvelope({ error: { code: 'unauthenticated', message: 'synthetic reject' } }));
            res.end();
            return;
          }
          watchRes = res;
          watches.add(res); res.on('close',()=>watches.delete(res));
          res.write(pb.envelope(buildConnected(queue.length)));
          return;
        }
        if (url.includes('PollGrokBotUserComputerRequests')) {
          const fields = pb.decodeFields(pb.unwrapConnectBody(raw));
          const acks = (fields[3] || []).filter((x) => x.t === 'b').map((x) => x.v.toString('utf8'));
          log.push({ kind: 'poll', acks, qlen: queue.length, machineId: pb.firstStr(fields, 1) });
          if (forceUnauth || pb.firstStr(fields, 2) !== (opts.credential || synCred)) {
            res.writeHead(401, { 'content-type': 'application/proto' });
            res.end();
            return;
          }
          if (acks.length) queue = queue.filter((x) => !acks.includes(x.id));
          const take = queue.slice(0, 8);
          res.writeHead(200, { 'content-type': 'application/proto' });
          res.end(buildPollResponse(take.map((x) => buildQueued(x.id, x.frameBuf))));
          return;
        }
        if (url.includes('SubmitGrokBotUserComputerResponses')) {
          const fields = pb.decodeFields(pb.unwrapConnectBody(raw));
          if (forceUnauth || submitUnauth || pb.firstStr(fields,2) !== (opts.credential || synCred)) { res.writeHead(401);res.end();return; }
          if (submitFailures > 0) { submitFailures--; res.writeHead(503); res.end(); return; }
          const frames = (fields[3] || []).filter((x) => x.t === 'b').map((x) => {
            const ff = pb.decodeFields(x.v);
            const rec = { requestId: pb.firstStr(ff, 1), textHints: [] };
            const type = [2,3,5,7].find(n=>ff[n]);
            if (!type) throw Error('unsupported response oneof');
            const payload=pb.decodeFields(ff[type][0].v);
            rec.kind=type;
            rec.message=type===2||type===3?JSON.parse(pb.firstStr(payload,1)):null;
            const rawS = x.v.toString('utf8');
            if (/oracle-fixture/.test(rawS)) rec.textHints.push('oracle-fixture');
            if (/streamClose/.test(rawS)) rec.textHints.push('streamClose');
            if (/readResult/.test(rawS)) rec.textHints.push('readResult');
            return rec;
          });
          log.push({ kind: 'submit', count: frames.length, frames, rawHex: body.length<65536 ? body.toString('hex') : undefined });
          res.writeHead(200, { 'content-type': 'application/proto' });
          res.end(buildSubmitAccepted(acceptedByRequest.get(frames[0]?.requestId) ?? acceptedOverride ?? frames.length));
          return;
        }
        if (url.includes('WithdrawGrokBotUserComputerPresence')) {
          const fields = pb.decodeFields(pb.unwrapConnectBody(raw));
          log.push({ kind: 'withdraw', machineId: pb.firstStr(fields, 1), presence: pb.firstStr(fields, 3) });
          res.writeHead(200, { 'content-type': 'application/proto' });
          res.end(buildWithdrawn(true));
          try { watchRes?.end(); } catch { /* ignore */ }
          watchRes = null;
          return;
        }
        res.writeHead(404);
        res.end('no');
      } catch (e) {
        log.push({ kind: 'handler-error', error: String(e && e.stack || e) });
        try { res.writeHead(500); res.end(); } catch { /* ignore */ }
      }
    });
  });

  return {
    SYN_CRED: synCred,
    SYN_MACHINE: synMachine,
    log,
    server,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)),
    port: () => server.address().port,
    enqueueExec(id, serverMessage) {
      const frameBuf = buildExecFrame(id, serverMessage);
      queue.push({ id, frameBuf });
      try { watchRes?.write(pb.envelope(buildNotify())); } catch { /* ignore */ }
    },
    setUnauth(v) { forceUnauth = !!v; },
    rotateCredential(v) { opts.credential = v; },
    rejectSubmits(v) { submitUnauth=!!v; },
    failSubmits(n) { submitFailures=n; },
    setAccepted(n) { acceptedOverride=n; },
    setAcceptedFor(id,n) { acceptedByRequest.set(id,n); },
    closeWatch() { for (const r of watches) r.end(); watchRes=null; },
    enqueueRaw(id,frameBuf) { queue.push({id,frameBuf}); try{watchRes?.write(pb.envelope(buildNotify()))}catch{} },
    enqueueBad(id) { queue.push({id,frameBuf:Buffer.concat([pb.encStr(1,id),pb.encMsg(2,pb.encStr(1,'{not-json'))])}); try{watchRes?.write(pb.envelope(buildNotify()))}catch{} },
    async close() {
      for (const r of watches) r.end();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { startUcFakePeer, SYN_CRED, SYN_MACHINE };
