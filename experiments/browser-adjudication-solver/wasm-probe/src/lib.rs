//! Disposable research ABI. This is not a product FEN validator or adjudicator.
use chasolver::{is_unwinnable_fast, winnability, Winnability};
use chess::{Board, BoardStatus, Color, MoveGen};
use std::str::FromStr;

static mut INPUT: [u8; 256] = [0; 256];
static mut OUTPUT: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 { std::ptr::addr_of_mut!(INPUT).cast::<u8>() }
#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 { unsafe { (&*std::ptr::addr_of!(OUTPUT)).as_ptr() } }
#[no_mangle]
pub extern "C" fn output_len() -> usize { unsafe { (&*std::ptr::addr_of!(OUTPUT)).len() } }

fn run(len: usize, color: u32, parse_only: bool) -> Result<String, &'static str> {
    if len > 256 || color > 1 { return Err("abi-input"); }
    let bytes = unsafe { std::slice::from_raw_parts(input_ptr(), len) };
    let fen = std::str::from_utf8(bytes).map_err(|_| "utf8")?;
    let board = Board::from_str(fen).map_err(|_| "board-parser")?;
    let winner = if color == 0 { Color::White } else { Color::Black };
    if parse_only { return Ok(format!("{{\"kind\":\"parsed\",\"normalized\":\"{board}\"}}")); }
    let fast = is_unwinnable_fast(&board, winner);
    let (kind, moves, verified) = match winnability(&board, winner) {
        Some(Winnability::Unwinnable) => ("unwinnable", Vec::new(), false),
        None => ("unknown", Vec::new(), false),
        Some(Winnability::Winnable { helpmate }) => {
            let mut next = board;
            let mut valid = true;
            for m in &helpmate {
                if !MoveGen::new_legal(&next).any(|legal| legal == *m) { valid = false; break; }
                next = next.make_move_new(*m);
            }
            valid &= next.status() == BoardStatus::Checkmate && next.side_to_move() != winner;
            ("winnable", helpmate, valid)
        }
    };
    let witness = moves.iter().map(|m| format!("\"{m}\"")).collect::<Vec<_>>().join(",");
    Ok(format!("{{\"kind\":\"{kind}\",\"fastUnwinnable\":{fast},\"rustWitnessVerified\":{verified},\"normalized\":\"{board}\",\"witness\":[{witness}]}}"))
}

#[no_mangle]
pub extern "C" fn solve(len: usize, color: u32, parse_only: u32) {
    let result = run(len, color, parse_only != 0).unwrap_or_else(|why| format!("{{\"kind\":\"invalid\",\"reason\":\"{why}\"}}"));
    unsafe { OUTPUT = result.into_bytes(); }
}
