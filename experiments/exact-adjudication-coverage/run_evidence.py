"""Bounded native research only. Every solver call is a disposable child process."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / '.cache'
CHA = CACHE / 'chasolver/chasolver-3484c7e65247003fac8705a9290dc2b5d0978b94'
EXE = CACHE / 'target/release/kha25-exact-probe.exe'

def load_chess():
    spec = importlib.util.spec_from_file_location('audit_chess', CACHE / 'python-chess.txt')
    # .txt is deliberately not importable by default. Load the pinned bytes explicitly.
    from importlib.machinery import SourceFileLoader
    spec = importlib.util.spec_from_loader('audit_chess', SourceFileLoader('audit_chess', str(CACHE / 'python-chess.txt')))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

def query(mode, fen, color='white', seconds=5):
    started = time.monotonic()
    try:
        p = subprocess.run([str(EXE), mode, fen, color], capture_output=True, text=True, timeout=seconds)
        try:
            result = json.loads(p.stdout)
        except json.JSONDecodeError:
            result = {'stdout': p.stdout, 'stderr': p.stderr}
        result['exitCode'] = p.returncode
    except subprocess.TimeoutExpired:
        result = {'execution': 'outer-timeout', 'verdict': 'unresolved'}
    result.update(wallSeconds=round(time.monotonic() - started, 6), outerLimitSeconds=seconds)
    return result

def verify_witness(chess, fen, color, result):
    if result.get('verdict') != 'winnable':
        return
    board = chess.Board(fen)
    legal = True
    first_product_end = None
    for ply, token in enumerate(result['moves'], 1):
        move = chess.Move.from_uci(token)
        if move not in board.legal_moves:
            legal = False
            break
        board.push(move)
        mate = board.is_checkmate()
        if first_product_end is None:
            if mate:
                first_product_end = {'ply': ply, 'reason': 'checkmate'}
            elif board.is_stalemate():
                first_product_end = {'ply': ply, 'reason': 'stalemate'}
            elif board.halfmove_clock >= 100:
                first_product_end = {'ply': ply, 'reason': '100-halfmoves'}
            elif board.is_repetition(3):
                first_product_end = {'ply': ply, 'reason': 'third-repetition'}
    result['independentReplay'] = {
        'allMovesLegal': legal,
        'intendedWinnerMates': legal and board.is_checkmate() and board.turn != (color == 'white'),
        'finalFen': board.fen(),
        'firstProductEnd': first_product_end,
    }

def main():
    chess = load_chess()
    env = os.environ.copy()
    env['CARGO_TARGET_DIR'] = str(CACHE / 'target')
    env['CARGO_HOME'] = str(CACHE / 'cargo-home')
    started = time.monotonic()
    build = subprocess.run(['cargo', 'build', '--release', '--locked', '--manifest-path', str(ROOT / 'probe/Cargo.toml')], env=env, capture_output=True, text=True, timeout=180)
    (ROOT / 'build.log').write_text(build.stdout + build.stderr, encoding='utf-8')
    assert build.returncode == 0
    output = {'environment': {'platform': platform.platform(), 'python': sys.version, 'rustc': subprocess.check_output(['rustc','--version'],text=True).strip(), 'cargo': subprocess.check_output(['cargo','--version'],text=True).strip(), 'target':'native Windows x86_64 MSVC', 'buildSeconds': round(time.monotonic()-started,4)}, 'parse': [], 'solve': [], 'sampledCorpus': []}
    parse_cases = {
        'ordinary': 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'noCounters': '4k3/8/8/8/8/8/8/R3K3 w - -',
        'badCounters': '4k3/8/8/8/8/8/8/R3K3 w - - nonsense -9 extra',
        'hugeCounters': '4k3/8/8/8/8/8/8/R3K3 w - - 999999999999999999999999 9999999999999999999',
        'missingKing': '8/8/8/8/8/8/8/R3K3 w - - 0 1',
        'adjacentKings': '8/8/8/8/8/8/4k3/4K3 w - - 0 1',
        'oppositeCheck': '4k3/8/8/8/8/8/8/4R1K1 w - - 0 1',
        'movingSideCheck': '4k3/8/8/8/8/8/4r3/4K3 w - - 0 1',
        'backRankPawn': '4k3/8/8/8/8/8/8/P3K3 w - - 0 1',
        'missingRookRight': '4k3/8/8/8/8/8/8/4K3 w K - 0 1',
        'kingAwayRight': '4k3/8/8/8/8/8/8/3K3R w K - 0 1',
        'junkRights': '4k3/8/8/8/8/8/8/4K2R w KXYZK - 0 1',
        'epUncapturable': '7k/8/8/4p3/8/8/8/4K3 w - e6 0 9',
        'epPinned': 'k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 9',
        'epBadRank': '7k/8/8/3pP3/8/8/8/4K3 w - d3 0 9',
        'epMissingPawn': '7k/8/8/4P3/8/8/8/4K3 w - d6 0 9',
        'epOccupied': '7k/8/3N4/3pP3/8/8/8/4K3 w - d6 0 9',
        'epOccupiedOrigin': '7k/3n4/8/3pP3/8/8/8/4K3 w - d6 0 9',
        'epBadCounter': '7k/8/8/3pP3/8/8/8/4K3 w - d6 45 9',
        'epJunk': '7k/8/8/3pP3/8/8/8/4K3 w - junk 0 9',
        'shortRanks': '4k/8/8/8/8/8/8/4K w - - 0 1',
        'tripleCheck': '4k3/8/8/8/1b6/5n2/8/4K2r w - - 0 1',
    }
    # Twenty non-king pieces plus a king, all locally consistent, no retrograde claim.
    high = chess.Board(None)
    high.set_piece_at(chess.A1, chess.Piece(chess.KING, chess.WHITE))
    high.set_piece_at(chess.H8, chess.Piece(chess.KING, chess.BLACK))
    for sq in [chess.square(f,r) for r in [0,2,4] for f in range(8) if (f,r) not in [(0,0),(6,4),(7,4),(5,4)]]:
        high.set_piece_at(sq, chess.Piece(chess.KNIGHT, chess.WHITE))
    parse_cases['manyKnights'] = high.fen()
    for name, fen in parse_cases.items():
        result = query('parse', fen)
        if name == 'manyKnights':
            result['independentLegalMoveOrigins'] = len({m.from_square for m in high.legal_moves})
            result['independentLegalMoves'] = high.legal_moves.count()
            result['oppositeKingAttacked'] = high.is_attacked_by(chess.WHITE, chess.H8)
            result['stockMovegenSkipped'] = 'Source has 18-entry array and unchecked insertion. Never invoke it on this fixture.'
        output['parse'].append({'id':name, 'fen':fen, 'result':result})
    cases = {
        'forcedCycle': 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
        'bareKingVsRook': '4k3/8/8/8/8/8/8/R3K3 b - - 0 1',
        'knightAssistedByRook': '6rk/8/3N3K/8/8/8/8/8 w - - 0 1',
        'twoKnights': '7k/8/5K2/4NN2/8/8/8/8 w - - 0 1',
        'counter99Queen': '7k/8/8/8/8/8/8/KQ6 w - - 99 1',
        'counter0Queen': '7k/8/8/8/8/8/8/KQ6 w - - 0 1',
        'counter99BlackToMove': '7k/8/8/8/8/8/8/KQ6 b - - 99 1',
        'counter0BlackToMove': '7k/8/8/8/8/8/8/KQ6 b - - 0 1',
        'mateOn100': '7k/8/6K1/5Q2/8/8/8/8 w - - 99 1',
        'asymmetricWall': '5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1',
        'challenge': '6kB/p3p1P1/2p3P1/p7/8/4P3/PKP5/8 w - - 0 1',
        'paperPosition12': '8/8/7p/5p1P/5p1K/5Pp1/6P1/5kb1 w - - 0 1',
        'paperPosition13': '1k6/1P5p/BP3p2/1P6/8/8/5PKP/8 w - - 0 1',
        'paperPosition14': '8/8/7p/5p1P/5p1K/5Pp1/6P1/1k6 w - - 0 1',
        'alreadyMated': '7k/6Q1/5K2/8/8/8/8/8 b - - 100 1',
        'alreadyStalemate': '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
        'loneKnightVsQueen': '7k/8/8/8/8/8/8/KN5q w - - 0 1',
        'sameColorBishopVsRook': '7k/8/8/8/8/8/8/KB5r w - - 0 1',
    }
    cases['mirroredAsymmetricWall'] = chess.Board(cases['asymmetricWall']).mirror().fen()
    for name,fen in cases.items():
        for color in ['white','black']:
            result = query('solve', fen, color)
            verify_witness(chess, fen, color, result)
            output['solve'].append({'id':name,'fen':fen,'intendedWinner':color,'result':result})
    # Deterministic source-corpus sample, not a full upstream-suite run.
    entries = [(i+1,x) for i,x in enumerate((CHA/'tests/positions.txt').read_text().splitlines()) if x and not x.startswith('#')]
    indices = sorted(set(list(range(min(24,len(entries)))) + [i*(len(entries)-1)//31 for i in range(32)]))
    sample_started = time.monotonic()
    for index in indices:
        if time.monotonic()-sample_started > 150:
            output['sampleStop'] = '150-second aggregate sample bound'
            break
        line, entry = entries[index]
        expected,fen = entry.split(' ',1)
        for color,want in [('white',expected[0]=='W'),('black',expected[1]=='B')]:
            result=query('solve',fen,color,seconds=3)
            verify_witness(chess,fen,color,result)
            output['sampledCorpus'].append({'sourceLine':line,'fen':fen,'intendedWinner':color,'upstreamExpectedWinnable':want,'result':result})
    (ROOT/'native-results.json').write_text(json.dumps(output,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'parse':len(output['parse']),'solve':len(output['solve']),'sampleQueries':len(output['sampledCorpus']), 'unknownOrTimeout': [x for x in output['solve']+output['sampledCorpus'] if x['result'].get('verdict') in ['unknown','unresolved']], 'badWitness': [x for x in output['solve']+output['sampledCorpus'] if x['result'].get('verifiedInRust') is False]},indent=2))

if __name__=='__main__':
    main()
