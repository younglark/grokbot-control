import json,sys,re
def load(f):
  d=json.load(open(f)); return {e['name']:e['frames'] for e in d['events'] if 'frames' in e and e['name']!='hello'}
def norm(fr):
  out=[]
  for f in fr:
    m=json.loads(json.dumps(f.get('message',{})))
    def strip(o):
      if isinstance(o,dict): return {k:strip(v) for k,v in o.items() if k not in('localExecutionTimeMs','id')}
      if isinstance(o,list): return [strip(x) for x in o]
      return o
    out.append((f['kind'],strip(m)))
  # merge consecutive stdout/stderr chunks (chunking is timing-dependent)
  merged=[]
  for k,m in out:
    ss=m.get('shellStream',{}) if isinstance(m,dict) else {}
    key=next((x for x in('stdout','stderr') if x in ss),None)
    if key and merged and merged[-1][2]==key: merged[-1][1]['shellStream'][key]['data']+=ss[key]['data']; continue
    merged.append([k,m,key])
  return [(k,m) for k,m,_ in merged]
a,b=load(sys.argv[1]),load(sys.argv[2]); same=diff=0
for n in a:
  if n not in b: print('MISSING',n); diff+=1; continue
  if norm(a[n])==norm(b[n]): same+=1; print('SAME ',n)
  else:
    diff+=1; print('DIFF ',n); print('   off:',json.dumps(norm(a[n]))[:900]); print('   our:',json.dumps(norm(b[n]))[:900])
print(f'same={same} diff={diff}')
