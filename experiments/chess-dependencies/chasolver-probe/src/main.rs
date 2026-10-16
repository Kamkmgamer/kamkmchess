use chasolver::{is_unwinnable_fast, winnability, Winnability};
use chess::{Board, BoardStatus, Color, MoveGen};
use std::str::FromStr;

fn main() {
    let cases = [
        ("lockedWall", "4k3/8/8/p1p1p1p1/PpPpPpPp/1P1P1P1P/8/4K3 w - - 0 1"),
        ("asymmetricWall", "5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1"),
        ("bareKingVsRook", "4k3/8/8/8/8/8/8/R3K3 b - - 0 1"),
        ("knightVsRook", "6rk/8/3N3K/8/8/8/8/8 w - - 0 1"),
    ];
    for (id, fen) in cases {
        let board = Board::from_str(fen).unwrap();
        for color in [Color::White, Color::Black] {
            let fast = is_unwinnable_fast(&board, color);
            let result = winnability(&board, color);
            let (verdict, moves) = match result {
                Some(Winnability::Unwinnable) => ("unwinnable", Vec::new()),
                Some(Winnability::Winnable { helpmate }) => {
                    let mut next = board;
                    for m in &helpmate {
                        assert!(MoveGen::new_legal(&next).any(|legal| legal == *m));
                        next = next.make_move_new(*m);
                    }
                    assert_eq!(next.status(), BoardStatus::Checkmate);
                    assert_ne!(next.side_to_move(), color);
                    ("winnable", helpmate)
                }
                None => ("unknown", Vec::new()),
            };
            let moves_json = moves.iter().map(|m| format!("\"{m}\"")).collect::<Vec<_>>().join(",");
            println!("{{\"id\":\"{id}\",\"fen\":\"{fen}\",\"intendedWinner\":\"{color:?}\",\"fastUnwinnable\":{fast},\"verdict\":\"{verdict}\",\"helpmate\":[{moves_json}]}}");
        }
    }
}
