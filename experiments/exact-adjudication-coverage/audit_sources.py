"""Record hashes, focused source excerpts and paper passages used by the report."""
import hashlib
import json
from pathlib import Path
import re
from html.parser import HTMLParser
from pypdf import PdfReader
from run_evidence import ROOT, CACHE, CHA

class HtmlText(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts=[]
    def handle_data(self,data): self.parts.append(data)

def main():
    review={'files':{},'excerpts':[],'papers':{},'fide':[]}
    sources={
        'solver-lib':(CHA/'src/lib.rs',[(24,76)]),
        'full':(CHA/'src/winnability/full.rs',[(20,121)]),
        'fast':(CHA/'src/winnability/fast.rs',[(122,180),(182,246)]),
        'search':(CHA/'src/search/engine.rs',[(131,171),(176,235)]),
        'forced':(CHA/'src/search/mod.rs',[(34,115)]),
        'check-chain':(CHA/'src/search/probes.rs',[(39,100)]),
        'static':(CHA/'src/deduction/mod.rs',[(20,108)]),
        'static-fields':(CHA/'src/deduction/analysis.rs',[(9,24),(154,201)]),
        'tests':(CHA/'tests/integration.rs',[(7,29),(31,67)]),
        'board':(CACHE/'chess/chess-3.2.0/src/board.rs',[(24,57),(613,681),(810,823),(1052,1086)]),
        'builder':(CACHE/'chess/chess-3.2.0/src/board_builder.rs',[(337,350),(366,381),(460,509)]),
        'move-list':(CACHE/'chess/chess-3.2.0/src/movegen/movegen.rs',[(24,31),(91,120)]),
        'unchecked-insert':(CACHE/'chess/chess-3.2.0/src/movegen/piece_type.rs',[(38,58)]),
        'syzygy':(CACHE/'syzygy.txt',[(1558,1573),(1656,1682)]),
        'popeye-readme':(CACHE/'popeye-readme.txt',[(1,75)]),
    }
    for label,(path,ranges) in sources.items():
        data=path.read_bytes(); lines=data.decode('utf-8').splitlines()
        review['files'][label]={'cachePath':str(path.relative_to(CACHE)).replace('\\','/'),'sha256':hashlib.sha256(data).hexdigest()}
        for first,last in ranges:
            review['excerpts'].append({'file':label,'firstLine':first,'lastLine':min(last,len(lines)),'text':'\n'.join(lines[first-1:last])})
    for name in ['paper','paper-full']:
        pages=[p.extract_text() for p in PdfReader(CACHE/(name+'.pdf')).pages]
        (CACHE/(name+'.txt')).write_text('\n\n'.join('PAGE '+str(i+1)+'\n'+text for i,text in enumerate(pages)),encoding='utf-8')
        review['papers'][name]={'pages':len(pages),'sha256':hashlib.sha256((CACHE/(name+'.pdf')).read_bytes()).hexdigest(),'passages':[]}
        for phrase in ['A position is','Lemma 5','Lemma 8','Theorem 12','for every d','not efficiently','nodes per iteration','tree of variations is']:
            for page,text in enumerate(pages,1):
                normalized=' '.join(text.split())
                start=normalized.lower().find(phrase.lower())
                if start>=0:
                    review['papers'][name]['passages'].append({'page':page,'phrase':phrase,'text':normalized[max(0,start-45):start+550]})
                    break
    parser=HtmlText();parser.feed((CACHE/'fide.txt').read_text(encoding='utf-8'))
    plain=' '.join(' '.join(parser.parts).split())
    for phrase in ['dead position','any possible series of legal moves','same positions','75 moves','seventyfive','last 50 moves']:
        for match in list(re.finditer(re.escape(phrase),plain,re.I))[:3]:
            review['fide'].append({'phrase':phrase,'text':plain[max(0,match.start()-200):match.end()+350]})
    (ROOT/'source-review.json').write_text(json.dumps(review,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print('Recorded',len(review['files']),'source files and',len(review['excerpts']),'excerpts')

if __name__=='__main__':main()
