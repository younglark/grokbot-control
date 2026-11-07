import json,sys
d=json.load(open(sys.argv[1]))
print(d['results'])
for e in d['events']:
  print('=== ',e['name'])
  for f in e['frames']:
    m=f.get('message',f); s=json.dumps(m)
    print('  ',f.get('kind'), s[:700])
