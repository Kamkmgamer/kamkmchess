"""Small cooperative reachability certificates. A bound returns unresolved, never a ruling."""
from collections import deque
import json
from pathlib import Path
import time
from run_evidence import load_chess, ROOT

chess = load_chess()

def key(board):
    return ' '.join(board.fen(en_passant='legal').split()[:4]) + ' 0 1'

def explore(fen, max_states, seconds):
    start = key(chess.Board(fen))
    seen = {start}
    queue = deque([start])
    nodes = []
    began = time.monotonic()
    while queue:
        if time.monotonic()-began > seconds:
            return {'status':'unresolved','reason':'wall-bound','seen':len(seen),'completedNodes':len(nodes)}
        position = queue.popleft()
        board = chess.Board(position)
        edges = []
        for move in board.legal_moves:
            board.push(move)
            target=key(board)
            board.pop()
            edges.append({'move':move.uci(),'target':target})
            if target not in seen:
                seen.add(target)
                if len(seen)>max_states:
                    return {'status':'unresolved','reason':'state-bound','seen':len(seen),'completedNodes':len(nodes)}
                queue.append(target)
        nodes.append({'state':position,'mate':board.is_checkmate(),'edges':edges})
    return {'status':'closed','root':start,'graphSemantics':'ordinary legal moves, no repetition/counter terminals','states':nodes,'elapsedSeconds':round(time.monotonic()-began,6)}

def verify(certificate):
    assert certificate['status']=='closed'
    nodes={x['state']:x for x in certificate['states']}
    assert len(nodes)==len(certificate['states'])
    assert certificate['root'] in nodes
    for state,node in nodes.items():
        board=chess.Board(state)
        assert not board.is_checkmate()
        expected={}
        for move in board.legal_moves:
            board.push(move)
            expected[move.uci()]=key(board)
            board.pop()
        assert expected=={e['move']:e['target'] for e in node['edges']}
        assert len(expected)==len(node['edges'])
        assert all(t in nodes for t in expected.values())
    return {'verified':True,'states':len(nodes),'edges':sum(len(x['edges']) for x in nodes.values()),'negativeForBothColors':True}

def product_counter_terminal(fen):
    board=chess.Board(fen)
    records=[]
    for move in board.legal_moves:
        board.push(move)
        records.append({'move':move.uci(),'mate':board.is_checkmate(),'halfmove':board.halfmove_clock,'productTerminal':board.is_checkmate() or board.is_stalemate() or board.halfmove_clock>=100})
        board.pop()
    return {'fen':fen,'successors':records,'allEndWithoutMate':all(x['productTerminal'] and not x['mate'] for x in records)}

def main():
    certificate=explore('k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',max_states=10000,seconds=3)
    (ROOT/'forced-cycle-certificate.json').write_text(json.dumps(certificate,indent=2)+'\n',encoding='utf-8')
    result={'certificateCheck':verify(certificate),
            'resourceBoundControl':explore('7k/8/8/8/8/8/8/KQ6 w - - 0 1',max_states=200,seconds=2),
            'counter99':product_counter_terminal('7k/8/8/8/8/8/8/KQ6 w - - 99 1'),
            'counter99BlackToMove':product_counter_terminal('7k/8/8/8/8/8/8/KQ6 b - - 99 1'),
            'rawBoardEncodingUpperBound':str(13**64*2*16*65)}
    assert result['counter99']['allEndWithoutMate']
    assert result['counter99BlackToMove']['allEndWithoutMate']
    assert result['resourceBoundControl']['status']=='unresolved'
    (ROOT/'closure-results.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'certificate':result['certificateCheck'],'boundControl':result['resourceBoundControl'],'counter99Successors':len(result['counter99']['successors'])}))

if __name__=='__main__':
    main()
