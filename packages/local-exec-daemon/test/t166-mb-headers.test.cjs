// t166: mb client headers vs the original builder, values derived statically from D:
//  eke(env,"desktop") 79157 → tse 79045 (variant) / QPe 79103 (isolated) → jAt 79135: ese 78973 (namespace, owner trimmed),
//  VPe 78996 + LAt/jPe 78967–78972 (version), BAt 79007 (source), FAt/$At 79021–79033 (UA), mb 79034–79044 (names/order).
// Synthetic env only; never runs the official binary.
const test=require('node:test'),assert=require('node:assert/strict');
const {backendClientFromEnv,clientHeaders}=require('../dist/state/connection-exchange');
const UA=(os,v)=>`Mozilla/5.0 ${os} AppleWebKit/537.36 (KHTML, like Gecko) Sand/${v} Safari/537.36`;
const L='(X11; Linux x86_64)';
const mb=(env,platform='linux')=>Object.entries(clientHeaders(backendClientFromEnv(env,platform)));
const exp=(ua,v,ns,os)=>[['user-agent',ua],['x-cursor-client-type','sand'],['x-cursor-client-version',v],['x-sand-box-namespace',ns],['x-cursor-client-os',os],['x-cursor-client-source','sand-desktop']];

test('dev (unpackaged) default: 0.79.3-dev / dev, exact names, values and insertion order',()=>{
 assert.deepEqual(mb({SAND_CLIENT_APP_VERSION:'0.79.3'}),exp(UA(L,'0.79.3-dev'),'0.79.3-dev','dev','linux'));
 assert.deepEqual(mb({}),exp(UA(L,'0.79.3-dev'),'0.79.3-dev','dev','linux'),'LAt falls back to bundled 0.79.3');
});
test('packaged / lab / owner namespace / isolated deployment',()=>{
 assert.deepEqual(mb({SAND_PACKAGED:'1',SAND_CLIENT_APP_VERSION:'1.2.3-beta.4'}),exp(UA(L,'1.2.3'),'1.2.3','prod','linux'));
 assert.deepEqual(mb({SAND_PACKAGED:'1',SAND_LAB:'1',SAND_CLIENT_APP_VERSION:'0.80.0'}),exp(UA(L,'0.80.0-lab'),'0.80.0-lab','lab','linux'));
 assert.deepEqual(mb({SAND_LAB:'1'}),exp(UA(L,'0.79.3-dev'),'0.79.3-dev','dev','linux'),'SAND_LAB alone stays sand-dev (tse)');
 assert.deepEqual(mb({SAND_PACKAGED:'1',SAND_BOX_OWNER_NAMESPACE:' lab '}),exp(UA(L,'0.79.3-lab'),'0.79.3-lab','lab','linux'));
 assert.deepEqual(mb({SAND_PACKAGED:'1',SAND_BOX_OWNER_NAMESPACE:'other'}),exp(UA(L,'0.79.3'),'0.79.3','prod','linux'));
 // isolated: namespace s = ese(owner, variant, true) = prod; version o = ese(owner, variant, false) = dev.
 const iso={SAND_ISOLATED_DEPLOYMENT:'1',SAND_BACKEND_URL:'http://127.0.0.1:1',SAND_CURSOR_WEBSITE_URL:'http://127.0.0.1:2'};
 assert.deepEqual(mb(iso),exp(UA(L,'0.79.3-dev'),'0.79.3-dev','prod','linux'));
 assert.deepEqual(mb({...iso,SAND_BOX_OWNER_NAMESPACE:'dev'}),exp(UA(L,'0.79.3-dev'),'0.79.3-dev','dev','linux'));
 assert.throws(()=>mb({SAND_ISOLATED_DEPLOYMENT:'1'}),/SAND_ISOLATED_DEPLOYMENT=1 needs SAND_BACKEND_URL/);
 assert.deepEqual(mb({SAND_CLIENT_APP_VERSION:' garbage '}),exp(UA(L,'0.79.3-dev'),'0.79.3-dev','dev','linux'));
 assert.deepEqual(mb({SAND_CLIENT_APP_VERSION:' 2.0.1 '}),exp(UA(L,'2.0.1-dev'),'2.0.1-dev','dev','linux'),'jPe trims');
});
test('platform user-agent strings ($At)',()=>{
 assert.equal(mb({SAND_PACKAGED:'1'},'darwin')[0][1],UA('(Macintosh; Intel Mac OS X 10_15_7)','0.79.3'));
 assert.equal(mb({SAND_PACKAGED:'1'},'win32')[0][1],UA('(Windows NT 10.0; Win64; x64)','0.79.3'));
 assert.equal(mb({SAND_PACKAGED:'1'},'freebsd')[0][1],UA('(compatible; freebsd)','0.79.3'));
 assert.equal(mb({SAND_PACKAGED:'1'},'win32')[4][1],'win32');
});
test('BAt: box/eval omit x-cursor-client-source; other sources pass through',()=>{
 const c=backendClientFromEnv({},'linux');
 assert.equal(clientHeaders({...c,clientSource:'box'})['x-cursor-client-source'],undefined);
 assert.equal(clientHeaders({...c,clientSource:'eval'})['x-cursor-client-source'],undefined);
 assert.equal(clientHeaders({...c,clientSource:'cli'})['x-cursor-client-source'],'cli');
 assert.equal(Object.keys(clientHeaders({...c,clientSource:'box'})).length,5);
});
