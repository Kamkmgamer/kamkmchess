"""Check saved synthetic evidence. Does not prove upstream unwinnability soundness."""
from pathlib import Path
import collections, hashlib, json, statistics
ROOT=Path(__file__).resolve().parent
read=lambda name:json.loads((ROOT/name).read_text(encoding='utf-8-sig'))
main=read('browser-results.json');stress=read('browser-stress-results.json');extended=read('browser-extended-results.json')
assert len(main['rows'])==41 and len(stress['rows'])==64 and len(extended['rows'])==2
rows=main['rows']+stress['rows']+extended['rows']
assert len(rows)==107
expected={'lockedWall':['unwinnable','unwinnable'],'asymmetricWall':['winnable','unwinnable'],'bareKingVsRook':['winnable','unwinnable'],'knightVsRook':['winnable','winnable']}
for row in main['rows']:
    if row['id'] in expected: assert row['kind']==expected[row['id']][0 if row['color']=='white' else 1]
for name,fixtures in [('browser-stress-results.json','stress-fixtures.json'),('browser-results.json','fixtures.json')]:
    labels={f['id']:f.get('upstreamExpected') for f in read(fixtures)['queries']}
    for row in read(name)['rows']:
        label=labels.get(row['id'])
        if label and row['kind'] in ['winnable','unwinnable']:
            assert (row['kind']=='winnable') == (label[0 if row['color']=='white' else 1]!='-')
for row in rows:
    assert 'witness' not in row['result'], 'Never serialize mating moves'
    check=row['result'].get('witnessCheck')
    if check:
        assert all(check[x] for x in ['rust','chessJs','chessops','expectedMatedColor'])
    memory=row['result'].get('memoryAfterBytes')
    if memory: assert memory<=134217728
stale=[r for r in main['rows'] if r['id'].startswith('stale-')]
assert len(stale)==5 and all(r['kind']=='discarded-stale' and not r['accepted'] for r in stale)
assert {r['invalidatedField'] for r in stale}=={'game','segment','positionRevision','requestGeneration','ownershipEpoch'}
for name in ['unknown-injected-none','unknown-budget-control','unknown-cancel-control','unknown-memory-limit-control','clock-pending-control']:
    row=next(r for r in main['rows'] if r['id']==name)
    assert row['kind']=='unknown' and row['timerTicks']>0
for result in [main,stress]: assert result['observations']['activeWorkers']==0
assert main['clockControl']['remainingMs']==0 and not main['clockControl']['moveAttempt']['accepted']
assert next(r for r in main['rows'] if r['id']=='counter99')['result']['witnessCheck']['earlierPolicyDraw']
for name in ['whitePromotion','blackPromotionMirror']:
    assert next(r for r in main['rows'] if r['id']==name)['result']['witnessCheck']['promotions']==1
assert next(r for r in stress['rows'] if r['id']=='stress-line-756')['kind']=='unknown'
assert extended['rows'][0]['kind']=='unknown' and extended['rows'][0]['budgetMs']==5000
artifact=read('artifact-inspection.json')
assert artifact['module']['imports']==[]
assert artifact['memory']==[{'flags':1,'minimumPages':31,'maximumPages':2048,'minimumBytes':2031616,'maximumBytes':134217728,'shared':False}]
assert hashlib.sha256((ROOT/'.cache/solver.wasm').read_bytes()).hexdigest()==artifact['sizes'][0]['sha256']==read('build-result.json')['wasmSha256']
completed=[r for r in rows if r['mode']=='analyze' and r['kind'] in ['winnable','unwinnable']]
def stats(values):return {'min':min(values),'median':statistics.median(values),'max':max(values)}
summary={'checks':'passed','finalRunRows':len(rows),'mainCounts':dict(collections.Counter(r['kind'] for r in main['rows'])),'stressCounts':dict(collections.Counter(r['kind'] for r in stress['rows'])),'extendedCounts':dict(collections.Counter(r['kind'] for r in extended['rows'])),'acceptedConclusiveAnalyses':len(completed),'positiveWitnessReplaysIncludingStaleControls':sum('witnessCheck' in r['result'] for r in rows),'acceptedPositiveWitnessReplays':sum(r['kind']=='winnable' for r in rows),'solveMs':stats([r['result']['solveMs'] for r in completed]),'endToEndMs':stats([r['elapsedMs'] for r in completed]),'maximumObservedCompletedLinearMemoryBytes':max(r['result'].get('memoryAfterBytes',0) for r in completed),'naturalUpstreamNoneObserved':False,'limitations':['Recorded upstream unwinnable verdicts are not independently proven here.','Counters/repetition are outside the solver state; legality-only witness checks do not establish the application draw policy.','WASM memory measurements exclude JS, JIT, browser process memory and memory of terminated queries.','Native target matrix, suspension and closed-tab recovery are untested.']}
(ROOT/'verification.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
