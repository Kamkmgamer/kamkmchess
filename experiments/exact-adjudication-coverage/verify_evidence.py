"""Check the recorded conclusions, certificate, links, pinned excerpts and normalized hashes."""
import hashlib
import json
from pathlib import Path
import re
import sys
from run_evidence import ROOT, CACHE, load_chess, verify_witness
from exact_closure import verify

REPO=ROOT.parent.parent
REPORT=REPO/'research/exact-adjudication-coverage.md'

def normalized_hash(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n',b'\n')).hexdigest()

def recorded_files():
    return [REPORT]+sorted(p for p in ROOT.rglob('*') if p.is_file() and '.cache' not in p.parts and '__pycache__' not in p.parts and p.name!='checksums.json')

def main():
    data=json.loads((ROOT/'native-results.json').read_text())
    assert len(data['parse'])==23
    assert len(data['solve'])==38
    assert len(data['sampledCorpus'])==110
    queries=data['solve']+data['sampledCorpus']
    chess=load_chess()
    counts={}
    for item in queries:
        result=item['result']
        assert result['exitCode']==0
        verdict=result['verdict']
        counts[verdict]=counts.get(verdict,0)+1
        if verdict=='winnable':
            assert result['verifiedInRust']
            assert result['independentReplay']['intendedWinnerMates']
            copied={k:v for k,v in result.items() if k!='independentReplay'}
            verify_witness(chess,item['fen'],item['intendedWinner'],copied)
            assert copied['independentReplay']==result['independentReplay']
        if 'upstreamExpectedWinnable' in item:
            assert (verdict=='winnable')==item['upstreamExpectedWinnable']
    assert counts=={'unwinnable':62,'winnable':86},counts
    assert sum(x['result']['fastUnwinnable'] is False and x['result']['verdict']=='unwinnable' for x in queries)==14
    parsed={x['id']:x['result'] for x in data['parse']}
    assert parsed['manyKnights']['whitePieces']==21
    assert parsed['manyKnights']['independentLegalMoveOrigins']==21
    assert parsed['manyKnights']['oppositeKingAttacked'] is False
    assert parsed['missingKing']['parse']=='reject'
    assert parsed['backRankPawn']['parse']=='accept'
    assert parsed['epPinned']['epPawn']=='d5'
    assert ' 0 1' in parsed['badCounters']['serialized']
    certificate=json.loads((ROOT/'forced-cycle-certificate.json').read_text())
    assert verify(certificate)=={'verified':True,'states':4,'edges':4,'negativeForBothColors':True}
    closure=json.loads((ROOT/'closure-results.json').read_text())
    assert closure['resourceBoundControl']['status']=='unresolved'
    assert closure['counter99']['allEndWithoutMate']
    assert len(closure['counter99']['successors'])==22
    assert closure['counter99BlackToMove']['allEndWithoutMate']
    text=REPORT.read_text(encoding='utf-8')
    definitions=dict(re.findall(r'^\[([^\]]+)\]:\s+(\S+)',text,re.M))
    uses=re.findall(r'(?<!!)\[[^\]]+\]\[([^\]]+)\]',text)
    assert all(x in definitions for x in uses)
    for target in definitions.values():
        if not re.match(r'https?://',target):
            path=(REPORT.parent/target).resolve()
            if '--write-checksums' in sys.argv and path==(ROOT/'checksums.json').resolve(): continue
            assert path.is_file(),target
    for doc in [REPORT,ROOT/'README.md']:
        for target in re.findall(r'\[[^\]]+\]\(([^)]+)\)',doc.read_text(encoding='utf-8')):
            if not re.match(r'https?://',target): assert (doc.parent/target).is_file(),target
    assert '\u2014' not in text and '\u2013' not in text
    review=json.loads((ROOT/'source-review.json').read_text(encoding='utf-8'))
    for record in review['files'].values():
        assert hashlib.sha256((CACHE/record['cachePath']).read_bytes()).hexdigest()==record['sha256']
    assert '8 passed; 0 failed' in (ROOT/'upstream-unit-tests.log').read_text()
    files=recorded_files()
    hashes={str(p.relative_to(REPO)).replace('\\','/'):normalized_hash(p) for p in files}
    if '--write-checksums' in sys.argv:
        (ROOT/'checksums.json').write_text(json.dumps(hashes,indent=2)+'\n',encoding='utf-8')
    else:
        assert hashes==json.loads((ROOT/'checksums.json').read_text()),'Recorded evidence checksum mismatch; inspect rerun results before replacing checksums.'
    print(json.dumps({'solverQueries':len(queries),'verdicts':counts,'independentPositiveReplays':counts['winnable'],'certificateStates':4,'reportReferenceDefinitions':len(definitions),'normalizedChecksums':len(hashes)},indent=2))

if __name__=='__main__':main()
