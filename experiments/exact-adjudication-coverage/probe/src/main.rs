use chess::{Board, BoardStatus, ChessMove, Color, MoveGen};
use chasolver::{is_unwinnable_fast, winnability, Winnability};
use std::{env, panic, str::FromStr};

fn main() {
    let args: Vec<String> = env::args().collect();
    let mode = &args[1];
    let fen = &args[2];
    panic::set_hook(Box::new(|_| {}));
    let parsed = panic::catch_unwind(|| Board::from_str(fen));
    let board = match parsed {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => { println!("{{\"parse\":\"reject\",\"error\":{:?}}}", e.to_string()); return; },
        Err(_) => { println!("{{\"parse\":\"panic\"}}"); return; },
    };
    if mode == "parse" {
        let ep = board.en_passant().map(|s| format!("{:?}", s.to_string())).unwrap_or_else(|| "null".to_owned());
        println!("{{\"parse\":\"accept\",\"serialized\":{:?},\"whitePieces\":{},\"blackPieces\":{},\"checkers\":{},\"epPawn\":{ep}}}", board.to_string(), board.color_combined(Color::White).popcnt(), board.color_combined(Color::Black).popcnt(), board.checkers().popcnt());
        return;
    }
    // Never run the stock generator beyond its usual material assumptions.
    assert!(board.color_combined(Color::White).popcnt() <= 16);
    assert!(board.color_combined(Color::Black).popcnt() <= 16);
    let color = if args.get(3).map(String::as_str) == Some("black") { Color::Black } else { Color::White };
    let started = std::time::Instant::now();
    let fast = is_unwinnable_fast(&board, color);
    if mode == "fast" { println!("{{\"fastUnwinnable\":{fast}}}"); return; }
    let answer = winnability(&board, color);
    match answer {
        Some(Winnability::Unwinnable) => println!("{{\"fastUnwinnable\":{fast},\"verdict\":\"unwinnable\",\"micros\":{}}}", started.elapsed().as_micros()),
        None => println!("{{\"fastUnwinnable\":{fast},\"verdict\":\"unknown\",\"micros\":{}}}", started.elapsed().as_micros()),
        Some(Winnability::Winnable { helpmate }) => {
            let mut b = board;
            let mut legal = true;
            for m in &helpmate {
                if !MoveGen::new_legal(&b).any(|x| x == *m) { legal = false; break; }
                b = b.make_move_new(*m);
            }
            let verified = legal && b.status() == BoardStatus::Checkmate && b.side_to_move() != color;
            let moves: Vec<String> = helpmate.iter().map(ChessMove::to_string).collect();
            println!("{{\"fastUnwinnable\":{fast},\"verdict\":\"winnable\",\"verifiedInRust\":{verified},\"moves\":{moves:?},\"micros\":{}}}", started.elapsed().as_micros());
        }
    }
}
