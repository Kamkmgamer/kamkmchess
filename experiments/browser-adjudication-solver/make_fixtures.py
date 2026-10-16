import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
base=[
    ('lockedWall','4k3/8/8/p1p1p1p1/PpPpPpPp/1P1P1P1P/8/4K3 w - - 0 1'),
    ('asymmetricWall','5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1'),
    ('bareKingVsRook','4k3/8/8/8/8/8/8/R3K3 b - - 0 1'),
    ('knightVsRook','6rk/8/3N3K/8/8/8/8/8 w - - 0 1'),
]
queries=[{'id':i,'fen':f,'color':c} for i,f in base for c in ['white','black']]
source=ROOT/'.cache/chasolver-3484c7e65247003fac8705a9290dc2b5d0978b94/tests/positions.txt'
lines=[(i+1,x) for i,x in enumerate(source.read_text().splitlines()) if x and not x.startswith('#')]
picked=[lines[3],lines[4],lines[len(lines)//4],lines[len(lines)//2],lines[3*len(lines)//4],lines[-1]]
for n,s in picked:
    fields=s[3:].split()
    fen=' '.join(fields if len(fields)==6 else fields+['0','1'])
    queries.extend({'id':f'upstream-line-{n}','fen':fen,'color':c,'upstreamExpected':s[:2],'budgetMs':3000} for c in ['white','black'])
queries.append({'id':'counter99','fen':base[2][1].replace('0 1','99 41'),'color':'white'})
queries.extend([
    {'id':'whitePromotion','fen':'7k/5P2/5K2/8/8/8/8/8 w - - 0 1','color':'white'},
    {'id':'blackPromotionMirror','fen':'8/8/8/8/8/5k2/5p2/7K b - - 0 1','color':'black'},
    {'id':'castlingMetadata','fen':'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','color':'white','parseOnly':True},
    {'id':'enPassantMetadata','fen':'4k3/8/8/3pP3/8/8/8/R3K3 w - d6 0 1','color':'white','parseOnly':True},
])
invalid=[
    ('garbage','garbage'),
    ('missingKing','8/8/8/8/8/8/8/4K3 w - - 0 1'),
    ('adjacentKings','8/8/8/8/8/8/4k3/4K3 w - - 0 1'),
    ('badCounter','4k3/8/8/8/8/8/8/R3K3 b - - -1 0'),
    ('extraField','4k3/8/8/8/8/8/8/R3K3 b - - 0 1 extra'),
    ('missingCounters','4k3/8/8/8/8/8/8/R3K3 b - -'),
]
queries.extend({'id':i,'fen':f,'color':'white','parseOnly':True} for i,f in invalid)
result={'selection':'Four reused synthetic fixtures, six deterministic upstream positions selected by file offset, a counter control, and parser-only invalid inputs. Upstream labels are claims, not an independent oracle.','upstreamPositionCount':len(lines),'queries':queries}
(ROOT/'fixtures.json').write_text(json.dumps(result,indent=2)+'\n')
print(f'{len(queries)} fixtures from {len(lines)} upstream positions')
stress=[]
for index in range(64):
    n,s=lines[(index*53)%len(lines)]
    fields=s[3:].split()
    fen=' '.join(fields if len(fields)==6 else fields+['0','1'])
    stress.append({'id':f'stress-line-{n}','fen':fen,'color':'white' if index%2==0 else 'black','upstreamExpected':s[:2]})
(ROOT/'stress-fixtures.json').write_text(json.dumps({'selection':'64 deterministic samples, indices i*53 modulo 3414, alternating intended winner, 1000ms per query and 55s aggregate start bound. These are a stress sample, not exhaustive coverage.','queries':stress},indent=2)+'\n')
