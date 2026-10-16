# Exact chess adjudication coverage

Research for [KHA-25](https://linear.app/kamkm/issue/KHA-25/establish-soundness-and-complete-outcomes-for-exact-chess-adjudication), 2026-10-16. This extends [the dependency report](chess-dependencies.md). It supplies evidence to KHA-13 and leaves integration and publication to the parent.

## Conclusion

No practical, guaranteed browser-local decision procedure for every permitted custom board is established by this research. CHA-Solver 3.0.0 has useful proof-oriented deductions, cooperative search and explicit undecided results. Its finite search limits do not implement the paper's unbounded completeness argument. The inspected Rust chess dependency also has a concrete input-domain hazard. It accepts a locally consistent board with 21 movable white origins, but its move generator allocates only 18 origin entries and inserts into them unchecked. Successful ordinary-game tests cannot establish safety on the accepted custom-board domain. [Pinned API][api], [full coordinator][full], [move generator][movegen], [unchecked insertion][piece-type], [native evidence][native].

An exact fallback exists in theory. Exhaust the finite cooperative position graph, or accept independently checked positive paths and negative closed-set or deductive certificates. A resource cutoff leaves that calculation unresolved. It never proves mating possibility or impossibility. This report implements a four-state negative closure certificate as research evidence. It does not implement a general production adjudicator or establish usable worst-case resources. [Certificate][certificate], [checker and exploration][closure-code], [results][closure-results], [paper, sections 2 and 4][paper].

Two separate gaps remain. First, the exact predicate must specify whether hypothetical mating continuations stop at the product's automatic third repetition and 100-halfmove endings. Those endings themselves remain approved. The solver ignores both history and counters, and a reproducible halfmove-99 example gives opposite answers under the two interpretations. Second, even after fixing that semantic choice, no complete implementation with an acceptable bound over the entire allowed domain is established. A bounded successful WASM build on KHA-24 cannot close either gap by itself. [Canonical requirements][canonical], [counter evidence][native], [complete one-ply counter analysis][closure-results].

## Contract and evidence labels

Native Linear reads confirmed KHA-13 comment `c4b31f8e-fcde-445c-920b-0632092bbb70`, KHA-11 comment `084530f6-8495-4a8c-b5b8-bcc93f7b10ac`, KHA-19 comment `549fc01e-8804-423d-a6f1-338981f2ae3d`, and KHA-22 comment `94aa261c-0c01-4973-b0de-73fc2c455782`. Their bodies and timestamps are saved in [canonical-comments.json][canonical]. The owner chose "Keep exact rules; research solver." No material exception, guessed unknown, provisional win, or historical-reachability restriction is approved.

The accepted domain checks the present board and settings. It does not demand a legal history from the normal start. Imported counters survive; a separate custom game starts its own repetition history. Terminal setups remain editable with Start disabled. No piece-count or promotion-budget restriction was approved. A current board may therefore fall outside the material counts of normal-start games. Arbitrary additional pieces are not automatically permission to accept adjacent kings, back-rank pawns, inconsistent rights or the nonmoving king in check. [Canonical custom-start resolution][canonical].

The browser owns legality, match transitions, clocks, discovery and direct AI generation. Hosted auth/database supplies private owner sync and ownership/CAS metadata. Continuous clocks and immutable results apply during analysis, errors, retries, Undo, recovery and suspension. No solver line, evaluation or legal-move list enters model advice. Native calculations below use only disposable synthetic fixtures and public source-test FENs. They are not browser, model-provider or production tests. [Assigned KHA-25 contract](https://linear.app/kamkm/issue/KHA-25/establish-soundness-and-complete-outcomes-for-exact-chess-adjudication), [canonical lifecycle][canonical].

Evidence labels in this report have specific meanings. Source describes inspected code or a primary specification. Upstream claim reports the author's assertion or benchmark. Observed describes the recorded experiments. Proof describes the argument given here or in the named paper. Proposal describes work that has not been implemented. Unknown identifies an unproved assumption or an unmeasured limit. Finite fixture coverage is never a universal proof.

## Pins and primary sources

Source pins and SHA-256 values are in [source-manifest.json][manifest]. Focused source excerpts, file hashes and extracted paper passages are in [source-review.json][review]. Downloads remain in the assigned ignored `.cache` directory.

- CHA-Solver 3.0.0 is commit `3484c7e65247003fac8705a9290dc2b5d0978b94`, MIT. Its Rust `chess` dependency resolves to 3.2.0, crate SHA-256 `2ed299b171ec34f372945ad6726f7bc1d2afd5f59fb8380f64f48e2bab2f0ec8`. The native probe's full dependency graph is in its [Cargo lockfile][lock].
- Miguel Ambrona, *A Practical Algorithm for Chess Unwinnability*, FUN 2022, DOI `10.4230/LIPIcs.FUN.2022.2`, is the 20-page published paper. The author's 25-page [full version][full-paper] includes proofs of the material lemmas and search heuristics. These are separate documents with separate hashes and different database snapshots. Do not combine their benchmark counts.
- The paper's original C++ implementation, formerly D3-Chess, is inspected at historical commit `e53a24147cda65bec1f93e5c7cd1f5b10d67a4ef`. Its banner is 2.5.2. The old repository name currently resolves to the same repository as the Rust rewrite. Its GPLv3/Stockfish dependency does not share the Rust release's MIT license. [Original source][old-code], [original README][old-readme].
- Popeye documentation is pinned at `006e480686bf167c2b79780984609aad746ce7a5`. python-chess and its Syzygy reader are pinned at tag `v1.11.2`. Their downloaded byte hashes are recorded. The latter supplies independent witness replay for this experiment, not a complete dead-position oracle. [Popeye manual][popeye], [python-chess][pychess], [Syzygy reader][syzygy].
- The rules reference is the official [FIDE Laws effective 2023][fide], particularly articles 5.1.1, 5.2.1, 5.2.2, 6.9, 9.2.3 and 9.6. Product threefold/100-halfmove rules remain intentional departures from FIDE claim and automatic-draw thresholds. [Canonical lifecycle][canonical].

## The predicate and every side-specific outcome

Proof: fix a state `s`, an intended winner `c`, a precisely defined legal-transition relation and checkmate terminals. Define `P(c,s)` to mean that at least one finite legal path from `s` ends in checkmate delivered by `c`. Both players cooperate along that path. Global deadness is `!P(White,s) && !P(Black,s)`. At an authoritative flag event, query the opponent of the expired player. A negative result means draw; a positive result means time loss for the expired player. An earlier terminal board result must already have taken precedence. This is the quantifier in FIDE 5.2.2 and 6.9 and the paper's Definition 2. [FIDE][fide], [paper][paper].

All four pairs matter:

- Both sides can mate. The position is not dead; either side loses if it flags while the position remains otherwise playable.
- Only White can mate. The position is not dead. White flagging draws; Black flagging loses to White.
- Only Black can mate. The position is not dead. Black flagging draws; White flagging loses to Black.
- Neither can mate. The position is dead and must end without waiting for a flag event.

Observed: `asymmetricWall` and its color/rank mirror exercise the two asymmetric pairs. `forcedCycle` exercises neither side. `knightAssistedByRook` exercises both. The prospective winner's remaining pieces alone do not determine these answers. The baseline's locked wall remains separate evidence and was not re-explored here. [Native cases][native], [baseline report](chess-dependencies.md).

Proof: ordinary optimal-play WDL asks whether a side can force a result against resistance. Its game recurrence includes an adversarial choice. Cooperative reachability uses an existential choice on both turns. Failure to force mate does not negate existence of a mating path. Two knights against a bare king are a concrete distinction: our valid `twoKnights` board has a verified 57-ply mating path. Likewise, `knightAssistedByRook` has a knight mate because the opposing rook can obstruct its own king. For a bare intended-winning king, that king cannot check another nonadjacent king, so no mating path exists even when the opposing side can mate it. [Witnesses][native], [material lemmas in full paper, section 2.1][full-paper].

A WDL draw or loss therefore cannot certify `!P`. A forced-mate proof can certify `P` within its exact domain, but a generic WDL win needs its terminal and rule assumptions checked too. Resignation, a winning evaluation and inability to defend are not a mating witness. A cooperative tablebase would use a different recurrence and is a possible exact alternative. [Syzygy minimax and fifty-move semantics][syzygy], [paper Definition 2 and Remark 1][paper].

## What the paper proves, and what the Rust release does

Source and proof: paper Definitions 3 and 4 use "sound" for never falsely declaring Unwinnable and "complete" for never falsely declaring Winnable, in an algorithm intended eventually to return a binary result. This differs from a library returning an honest undecided value. The published abstract's "sound, complete and efficient" refers to the paper's algorithm and empirical practicality, not a theorem that every Rust API call finishes within its configured budgets. [Paper, sections 1, 2 and 4][paper].

The paper's argument has distinct parts:

1. Lemmas 5 and 6 prove pawn-free material impossibility for a lone knight against kings/queens, and same-square-color bishops against material without knights or opposite-square-color bishops. The full proofs reason about necessary escape squares and an available capture or interposition. They do not use optimal-play WDL. The lone-knight proof explicitly permits any number of opposing queens. [Full paper, section 2.1][full-paper].
2. Lemma 8 and Corollary 9 prove that the mobility calculation over-approximates future piece reachability. Their stated precondition excludes castling rights and possible en passant. Lemmas 10 and 11 establish monotonicity and soundness of the static mate-impossibility check. Theorem 12 composes those facts. A positive mobility approximation does not prove a real mating path. [Paper, sections 3.1 and 3.2][paper].
3. Figure 9 loops over every natural-number depth with a growing node bound. Finding a mate certifies possibility. Fully exhausting the remaining variations without interruption certifies impossibility. The completeness argument depends on eventually reaching sufficient depth and work. The paper's benchmark footnote admits that its practical constant 10,000-node choice is not that theoretical increasing bound. [Paper, section 4, Figure 9 and section 5.1 footnote 9][paper].

Source: the formal notation distinguishes a nonoverlapping "valid" placement from a historically reachable "legal" position. The material arguments and transition-graph proof do not by themselves require a normal-start history. That is useful, but it does not prove the entire optimized Rust implementation correct on every locally valid unreachable board. Its data structures and additional deductions need their own audit over that domain. [Full paper, section 2][full-paper], [Rust analysis][analysis].

Source: the Rust release has additional logic beyond the paper's printed static algorithm. It adds capturability assumptions and case splits, permanent-attacks tracking, bishop transparency, a stalemate filter and checks for non-king blockers. Its static entry rejects stored en passant, but does not reject castling rights as Figure 8 does. The ordinary piece-reachability helper does not generate castling moves. Some castling effects may be conservatively covered through ordinary king/rook reachability, but the paper's theorem is not a proof of that changed implementation. A separate simulation argument or reviewed guard is needed. No failing castling classification was reproduced here. [Static entry][deduction], [saturation and filters][saturation], [piece geometry][geometry], [paper Figure 8][paper].

Unknown: this audit is not a formal verification or a complete proof of each new filter. In particular, the paper's same-color-bishop static test is not identical to the Rust `black_could_get_mated` calculation and its piece-fate case splits. Passing the recorded cases supports investigation, not unconditional trust in every negative result. A certificate checker could establish negative results using a separately justified rule set or graph closure. The Rust API currently returns `Unwinnable` without such a certificate or a reason code. [Analysis][analysis], [static entry][deduction], [API][api].

## Source-level decision paths and search limits

Source: `is_unwinnable_fast(board,color)` returns `true` for a claimed proof of impossibility. `false` is explicitly inconclusive. The full API returns `Some(Winnable { helpmate })`, `Some(Unwinnable)` or `None`. None means undecided, not draw, win, probably winning, parser failure or a negative proof. A process error, cancellation, outer timeout, invalid witness or rejected input also needs its own non-result state. [API][api].

The full coordinator runs these phases in order. Numbers here describe source budgets, not browser measurements. [Coordinator][full], [search engine][engine], [probes][probes].

1. Follow up to 16 uniquely forced plies. A repeated board in a sequence with exactly one legal successor proves a nonmating cycle. In the ordinary move graph, no cooperative alternative can escape it. Search retains the forced prefix for its normal mating-line path. [Forced sequence code][search-mod].
2. Try shallow extended search at depth 1, with a 1,000-node-per-depth budget.
3. Try static analysis early if queens, rooks and knights are absent.
4. Iteratively search depths 2 through 128 with a transposition table, per-depth multiplier 7,000 and the default global limit 1,000,000 for this invocation.
5. Try static analysis if phase 3 was skipped.
6. Probe up to 1,000 candidate moves to select a possible pawn-only case. The subsequent exhaustive closure returns true only if it closes without a target mate, and stops unsuccessfully if it grows beyond 3,000 positions. The probe selects work; failure to observe a non-pawn move is not itself the negative proof. [Fast/closure code][fast].
7. Follow check chains with a visited set and depth cutoff above 16. A None leaf keeps the result unresolved; negative leaves use static analysis.
8. Use bishop-distance and move heuristics with a global candidate-move limit `1 << 24`, which is 16,777,216, and depths 2 through 128. The recursive search also limits the actual stored path to 128 plies.

The search counts candidate moves as nodes. It adjusts effective depth for rewarded or punished moves. These heuristics affect which branch gets time first. A depth or node cut sets `interrupted`; an exhausted search is negative only when that flag stayed false. This explains the intended soundness distinction between exhaustion and cutoff. It does not prove there is a witness within 128 plies for every permitted board. [Engine][engine], [heuristics][heuristics], [iteration result handling][search-mod].

The final node cap is not a cap on all work, elapsed time or peak memory. Fast bounded-depth recursion has no separate global node counter. Static saturation and case splits, the check-chain phase and earlier searches are separate work. Hash-map initial capacity is not a hard memory ceiling. The API has no caller-supplied deadline or cancellation token. Worker termination and result fencing remain application work, and KHA-24 owns browser measurements. [Fast recursion][fast], [static analysis][deduction], [full coordinator][full].

Source: `chess::Board` derives structural equality; its `Hash` implementation hashes a stored hash value. Rust hash sets/maps still check equality, so a numerical hash collision alone does not make these sets identify different boards. A new fallback must likewise compare complete canonical states instead of treating a 64-bit hash as a proof of identity. [Board type and hashing][board-src].

### Positive witnesses need checking

Proposal: replay every move against a separately validated snapshot and legal-move implementation. Require correct turn, origin/destination/promotion, legal castling/en passant, no intervening terminal state under the chosen predicate, and final checkmate of the intended loser. An empty line is valid only if the queried board already has that checkmate. Verify color/rank mirroring for Black and any forced prefix. A malformed, missing or stale witness supplies no positive decision. [API and mirroring][api], [mirror code][mirror], [independent replay code][evidence-code].

Source finding: `check_chain_search` returns `Winnable { helpmate: vec![] }` at a target checkmate, and its recursive callers return that result without prepending their moves. Full phase 7 returns it directly. Thus this branch does not construct the path needed by the public witness contract. The sampled public calls did not exercise a bad witness, and this report does not claim a reproduced public-API counterexample. The source branch still requires repair or independent path reconstruction before every positive result can satisfy the required witness policy. [Probes][probes], [phase 7][full], [native replay observations][native].

Positive checking is comparatively cheap because it checks one finite path. It cannot certify the negative result "there is no path." Nor can it rescue a genuinely unwinnable position when the solver has returned None. The accepted no-advice boundary permits this checker only for adjudication; its line must remain outside model requests, corrections and strategic hints. [Canonical/assigned requirements][canonical].

## Custom-board domain and Rust input boundaries

Source: `BoardBuilder::from_str` reads at least four space-separated fields, parses pieces with wrapping rank/file operations, tests castling flags by substring, and retains only an en-passant file. It does not parse the counter fields. `Board::try_from` then checks board sanity. Constructing `Board` is neither strict six-field FEN validation nor a historical-legality proof. `BoardBuilder` stores one piece per square and offers a safer structural construction route after an application validator has checked the original draft. [Builder source][builder-src], [Board conversion and sanity][board-src].

Observed boundaries in the 23 parse fixtures are recorded verbatim in [native-results.json][native]:

- Missing kings, adjacent kings, a nonmoving king in check, rights without a rook and rights with an off-home king were rejected. A moving king in check was accepted.
- A pawn on a back rank, shortened FEN ranks, junk/duplicate castling text and nonsensical or absent counters were accepted. Serialization repaired shortened placement, collapsed the flags and printed counters as `0 1`. These inputs need rejection or preservation in the application draft, not silent approval based on library construction.
- The uncapturable but consistent `e6` declaration was discarded. A pinned `d6` ep declaration remained stored because a geometrically adjacent capturing pawn existed. The internal ep square is the pushed pawn's square, `d5`, and the observed display also printed `d5`. Do not round-trip this display as authoritative imported FEN.
- Invalid ep rank `d3` became that same stored `d5`. Junk ep text became absent. An occupied target, occupied double-push origin and inconsistent halfmove counter were accepted. Missing pushed pawn with an adjacent capturer was rejected. The source's normalization depends on board content, so one rejection is not a comprehensive ep validator.
- A triple-check setup was accepted. The product's phrase "side-to-move/check consistency" still needs a precise local rule for such cases. Rejecting all unreachable checks because a general-purpose `is_valid()` helper flags them would exceed the explicit no-full-history-proof boundary unless the actual check is justified as present-state inconsistency.

Proposal: prevalidate original placement, exact six-field syntax and integers, king counts and separation, pawn ranks, nonmoving-king safety, orthodox rights, and ep target/pawn/origin/turn/counter consistency. Keep declared ep for display and saved/model FEN; use legally effective ep in repetition identity. Do not require an adjacent capturer for a valid declared double push. Preserve counters independently with exact numeric representation. Avoid parser output as the source of truth. This is additional validation, not permission to require a normal-start proof. [Custom-start contract][canonical], [baseline analysis](chess-dependencies.md), [FIDE piece/castling/ep rules][fide].

### Accepted material can exceed a dependency's assumptions

Observed: this FEN has one separated king per side, no back-rank pawn, no rights or ep, and the nonmoving king is not attacked:

```text
7k/8/8/NNNNN3/8/NNNNNNNN/8/KNNNNNNN w - - 0 1
```

Rust accepted it and reported 21 white pieces. Independent python-chess legal generation found 67 moves from 21 origins. The experiment deliberately did not call stock Rust move generation on it. Source `MoveList` has capacity 18 `SquareAndBitBoard` entries, and the per-piece generator calls `push_unchecked` for each movable origin. This fixture needs at least 21 entries. The precondition for those unchecked writes is therefore violated on a board the parser accepts and the product has not excluded. This is a source-level memory-safety finding supported by independent origin counting, not an observed crash or a WASM experiment. [Move list][movegen], [insertion][piece-type], [fixture and count][native].

Unknown: the report does not claim that enlarging that array alone repairs every Rust assumption for up to 64 occupied squares, arbitrary same-type counts, unusual checks and promotions. A safe adapter/fork or another move generator needs a full audit and transition agreement tests for that domain. Promoted extra material within 16 pieces per side also needs coverage; "normal material" is not the accepted contract. The experiment's own solve guard at 16 per side prevents unsafe research execution. It is explicitly not a proposed product restriction. [Harness][probe-code], [canonical input domain][canonical].

Source and proposal: `mirror_board` rebuilds a Black-winner query through `BoardBuilder` and calls `expect("Failed to mirror board")`. Several search/deduction paths unwrap piece/king lookups. Validated data should satisfy those preconditions, but a panic is a computational failure, never a chess verdict. Preserve the original state, isolate native/WASM failures and fence results. This audit observed parser rejection paths but no parser panic or solver crash in its chosen cases. [Mirror][mirror], [native results][native].

## Draw thresholds, history and the unresolved predicate

Source: the solver's `Board` has no halfmove/fullmove counters or repetition ledger. Its searches stop at mate/stalemate and selected proven impossibility cases; they do not implement the product's automatic third repetition or 100-halfmove policy. The paper defines an any-legal-sequence predicate, mentions 75-move/fivefold finiteness in a full-version footnote, and also permits ignoring those rules while collapsing explored positions. It does not define this product's modified history-aware predicate. [Board][board-src], [engine][engine], [full paper, section 2 footnote 4][full-paper].

Observed and proved for the fixture: start with `7k/8/8/8/8/8/8/KQ6 w - - 99 1`. CHA-Solver gives White the same 23-ply mating line it gives at halfmove 0. Independent replay verifies its geometric legality and final mate. Yet every one of the initial 22 legal moves is quiet, none checkmates, and every one reaches halfmove 100. The product therefore ends immediately after any first move if its automatic rule governs the hypothetical continuation. Exhaustive one-ply enumeration proves there is no product-permitted mating continuation in this state. This is stronger than merely observing that one returned witness is unsuitable. [Native evidence][native], [one-ply proof records][closure-results].

The companion `counter99BlackToMove` fixture changes the turn to Black, so White is the prospective winner if the active Black clock expires. The solver again supplies a geometric White mating line, while every Black first move reaches the product draw threshold without mate. This makes the timeout interpretation conflict direct as well as showing the global-deadness interaction. Under the product-continuation interpretation, some positions would become dead before the actual threshold move. That consequence also needs explicit specification. [Native evidence][native], [counter control][closure-results].

The settled requirements leave two interpretations to reconcile:

- A board-based FIDE-style mating predicate ignores repetition/counter draw terminals for the hypothetical possibility test. The actual match separately ends at the approved third repetition or 100 halfmoves. Under this interpretation, White can possibly mate in the halfmove-99 fixture, even though actual play will draw before reaching that mate.
- A product-continuation predicate stops the hypothetical path at those automatic terminals too. Then the halfmove-99 fixture is unwinnable for White, and the result depends on the imported halfmove count and retained repetition ledger as well as board state. Counter-blind CHA positives require further search or validation. Its sound negatives for the larger ordinary graph would remain safe for this smaller continuation graph, if source/domain soundness were established.

These are interpretations of a genuine unresolved interaction, not replacement draw policies. Neither is silently selected here. The automatic thresholds and checkmate precedence stay as agreed. An architectural specification must explicitly state which terminal rules constrain the existential path used for deadness and flag fall, and use the same interpretation in oracle tests and match transitions. Article 6.9 alone and a FEN-only API do not settle the product's added interaction. [FIDE][fide], [canonical policy][canonical].

Observed: `mateOn100` starts at 99 and has a verified one-ply checkmate at counter 100. The replay checks mate before the halfmove draw and records checkmate. A threshold-aware fallback must do the same. `alreadyMated` is also correctly classified as an existing mate, although Start must remain disabled on that setup. No solver may turn a previously accepted mate into a later flag or draw. [Native controls][native], [canonical precedence][canonical].

History matters under the second interpretation. A fresh custom start counts once. A resumed/Undo-restored current line has its retained occurrences. FEN cannot reconstruct those occurrences, and fullmove number does not supply them. A cache keyed by FEN placement alone is then invalid. A witness that traverses an earlier twice-seen state might trigger the third repetition before mating; testing only the witness's internal repeats misses that. Under the first interpretation, historical occurrences affect actual match endings but not the geometric `P` cache. Both still need correct repetition equality including legal ep availability and rights. [Canonical history/Undo rules][canonical], [FIDE 9.2.3][fide], [baseline repetition observations](chess-dependencies.md).

## Exact fallback and certificate strategy

Proof: for the board-based predicate, use states containing all piece types/colors/squares, turn, castling rights and legally effective ep. Legal moves preserve a finite state universe. Captures decrease occupancy; promotion changes a piece's type without adding a square. Fullmove number does not affect move legality and can be omitted from this oracle key while remaining preserved in saved state. Halfmove count can be omitted only if it does not constrain the selected predicate. Distinct positions must not merge merely because a hash collides. [FIDE move and state rules][fide], [paper exhaustive-search argument][paper].

A deliberately loose upper bound is `13^64 * 2 * 16 * 65`, about `4.1 * 10^74` raw encodings. Each square has empty or one of twelve piece/color values; the remaining factors encode turn, rights and absent-or-square ep. King and consistency constraints remove many encodings. This bound proves finiteness, not feasibility, and includes the allowed nonhistorical material counts. [Bound calculation][closure-results].

Proof: perform a full-width BFS/DFS from the query root. At either side's turn, explore every legal successor. Return positive only with a replayed path to target mate. Treat other terminal outcomes as leaves according to the chosen semantics. Return negative only after the entire reachable frontier is exhausted, with no target mate. A complete visited-state representation handles cycles. The reachability least fixed point, or SCC condensation of the exhausted graph, gives the same answer. No minimax or best-defense choice appears in this algorithm. The finite universe establishes eventual termination given sufficient memory/work; it supplies no small practical bound. [Paper, sections 2.2 and 4][paper], [research implementation][closure-code].

Proof: a negative closed-set certificate consists of a finite set `C` containing the root, no target checkmate, and every legal successor of every nonterminal member also in `C`. Any finite path from the root remains in `C` by induction on its length. Therefore no target mate is reachable. A verifier must regenerate all legal successors; checking only the provided edges would allow omitted moves to create a false certificate. A mate-free SCC without a proof that no exit reaches mate is insufficient. A reachable-state list need not be minimal, but all its state and terminal assumptions must match the query. [Certificate/checker code][closure-code].

Observed: the `forcedCycle` fixture closes in four exact board states and four legal edges. The independent checker regenerated every successor and checked that no state is checkmate. This proves negative for both colors for this ordinary-move graph and also any smaller graph whose draws stop paths earlier. The certificate includes its root and graph semantics. A queen-position exploration stopped at 201 seen states under a 200-state allowance and reported unresolved, not a negative. The closure runner has a three-second bound for the cycle and a two-second bound for that cutoff control. [Certificate][certificate], [results][closure-results].

The executable certificate check still trusts the independent move generator and canonical-state implementation to enumerate all legal successors correctly. The mathematical closed-set argument is separate from a formal verification of that software. Two implementations agreeing on finite fixtures does not prove either implementation universally correct. A production proof checker needs this trusted code and its accepted domain reviewed too. [Checker source][closure-code], [independent rules source][pychess].

Proposal: use audited deductive certificates to avoid enumerating huge closed sets. Examples include a bare-king proof, the paper's material lemmas within their preconditions, and inductive pawn-barrier/reachability invariants with enough information for a small independent checker. The proof must cover promotions, sacrifices, ep, castling and side-to-move terminals as relevant. A claimed mobility over-approximation is not a certificate merely because its source comment says it is sound. Every additional filter needs a preservation argument. This report supplies only the explicit four-state closure checker, not a general deductive-certificate implementation. [Paper theorem and hypotheses][paper], [Rust changes][saturation].

For product-continuation semantics, lift each state to include the halfmove counter and sufficient repetition history. Nonterminal occurrences are bounded by two under automatic threefold; counters reach a terminal at 100 unless the same move checkmates first. Over the finite board universe, an occurrence map with entries 0, 1 or 2 is finite too, though much larger. Preserve original fullmove counters outside that graph. Any quotient, such as resetting an irrelevant repetition prefix after irreversible moves, needs proof before using it to merge states. FEN-only visited sets and certificates would not be complete state descriptions. [Canonical thresholds/history][canonical], [FIDE repetition identity][fide].

Proposal: a bounded SAT/SMT encoding could certify a mating path of length at most `n`. UNSAT certifies only that bounded claim. It becomes a complete negative proof only with an independently justified completeness diameter covering the chosen graph, or another unbounded inductive proof. The same restriction applies to fixed-depth helpmate search. No SAT/SMT solver, encoding proof, useful diameter or browser resource bound was established here.

### Credible alternatives and their limits

Source: original CHA 2.5.2 provides a C++/Stockfish implementation and a configurable node limit. Its full search still has fixed practical limits and an UNDETERMINED outcome. Its command-line `-timeout` mode treats any result other than UNWINNABLE as a win, and comments explicitly describe guessing unresolved quick cases as winnable. That wrapper violates this task's contract. It cannot be adopted as the exact fallback. This research inspected its source but did not build or execute it. [Historical coordinator/wrapper][old-code], [historical search][old-search], [README and GPL requirements][old-readme].

Source: Popeye is a mature chess-problem solver. Its manual describes helpmate stipulations, maximum halfmove branch lengths, exact/minimal lengths, memory settings and MaxTime. It is a credible source of independently checkable positive paths or fixed-length negative searches. Its documentation does not establish an unbounded universal dead-position adjudicator, history semantics for this product, or the full accepted custom-board safety domain. No Popeye build, result or browser claim was reproduced. Its README's WebAssembly portability statement is an upstream claim and belongs in any later portability evaluation. [Pinned manual][popeye], [README][popeye-readme].

Source: Syzygy supplies optimal-play WDL/DTZ with fifty-move semantics and a limited material/table-file domain. The pinned reader rejects castling rights and handles missing tables as errors. These are not cooperative impossibility certificates for all custom boards. A purpose-built cooperative tablebase could solve all states of a completely enumerated material class, including possible same-material transitions and capture/promotion dependencies. It must report out-of-domain or missing entries as unresolved. Expanding the tablebase to every permitted class requires addressing up to the whole allowed board domain, not selecting a small convenient material set. No such universal tablebase was established. [Pinned reader][syzygy].

Source: python-chess's `has_insufficient_material()` documentation explicitly admits that fortress positions or forced lines can return false despite no winning line. It is useful for independent move replay and some sufficient material proofs. It is not another complete fallback. Its broader `status()` also imposes material and impossible-check checks; adopting that whole validator would silently change the accepted domain. [Pinned source][pychess].

## Unknowns, clock consequences and parent integration

Unknown: no practical guaranteed time/memory bound, complete coverage proof for Rust's changed deductions, or safe full-domain Rust move-generation adapter is established. No naturally occurring full None was reproduced in this sample. The README claims resolution on every known legal real or constructed position while explicitly denying theoretical completeness. Its real-game throughput and worst-case benchmark claims do not bound adversarial permitted custom boards or the required devices. [Pinned README][readme], [observations][native].

Source tests explain that limitation. `positions.txt` contains 3,414 classified community FEN entries and `lichess.txt` contains 65,536. Integration tests query both colors, panic on None and compare negative verdicts to supplied expected labels. Positive replay checks the final board using the same dependency, without explicitly validating each intermediate move. Such tests catch regressions but do not create independent negative proofs or universal coverage. The source suite has no expected-None class. The published 2022 paper's quick-version misses were Positions 12, 13 and 14, plus an artificial difficulty warning for Position 12 with extra dark-squared bishops. Those historical observations must not be reported as current Rust failures. Our current release resolved both colors on all three reconstructed base positions, with fast true for their negative classifications. [Integration tests][tests], [paper sections 5.1 and 5.2][paper], [native cases][native].

Proposal: keep adjudication pending while evidence is unresolved, with no guessed result and no move applied past an earlier unresolved terminal event. This is an internal computation state, not an accepted new product promise to wait indefinitely. Capture the event's actual position and authoritative elapsed-time/deadline facts. Pending work must neither pause a clock, award increment, refund elapsed time, accept a late move nor let Undo erase an already elapsed flag. A dead-position event might precede a later clock expiry; determine the earlier event before settling the immutable result. If play waits for classification, its clock cost and timeout ordering remain real. [Canonical lifecycle][canonical].

Every asynchronous result must carry game ID, practice segment ID, position revision, request/analysis generation and ownership epoch/CAS base. Invalidate work on Undo, handoff, takeover, new segment or replacement query even if the FEN repeats. A recovered browser must restore the pending query and reconcile elapsed time before accepting a move. Offline divergent work remains a separately retained continuation and cannot overwrite an accepted cloud history/result. These are integration obligations from the assigned boundary, not tested persistence behavior in this report. [Assigned task](https://linear.app/kamkm/issue/KHA-25/establish-soundness-and-complete-outcomes-for-exact-chess-adjudication), [canonical lifecycle][canonical].

The smallest precise next specification question is which draw terminals constrain hypothetical mate reachability. After that, the remaining engineering constraint is explicit: establish complete, safe browser-local classification on all permitted current-state-valid boards with an acceptable resource/latency contract, or identify that those simultaneous requirements cannot yet be delivered. No approved rule authorizes discarding a board because the solver is unknown, treating a failed witness as a win, using a server authority, or settling a temporary result. An indefinite pending state alone is not a practical guaranteed solution.

The parent must reconcile this report with KHA-24 on these points before resolving architecture:

1. Use the exact source/patch hash and input contract actually built. The 18-entry move-origin hazard and castling/static-proof gap apply regardless of successful compilation.
2. Distinguish `Unwinnable`, verified `Winnable`, None, missing/invalid witness, panic, cancellation and resource exhaustion. KHA-24's budgets must preserve the unresolved cases as computational non-results.
3. State the chosen hypothetical-path semantics and pass counters/history to any threshold-aware checker. Checkmate still takes precedence at an actual threshold boundary.
4. Specify an exact fallback and negative-proof trust boundary. If only the bounded solver exists, complete coverage remains unestablished.
5. Keep local adjudication isolated from model move choice, preserve live clocks and stale-result fences, and distinguish measured native targets from the untested Windows Firefox/macOS Safari/iOS Safari/Android Chrome matrix.

## Reproduction, checks and cleanup

Worktree is `C:\Users\Lenovo\.t3\worktrees\kamkmchess\t3-1fec5d98`, branch `t3/exact-chess-adjudication`, based on `27a53c1`. Assigned deliverables are this report and `experiments/exact-adjudication-coverage/`. The [experiment README][experiment-readme] gives commands and bounds. [checksums.json][checksums] hashes tracked evidence as LF-normalized text and downloads separately by original bytes in the manifest.

Observed checks: the final native run made 23 parse probes and 148 solver queries, including 38 named side-specific queries and 110 deterministic queries from 55 community fixtures. It returned 86 positive and 62 negative classifications. All 86 positive witnesses passed explicit move-by-move Rust validation and independent python-chess replay, including existing-checkmate empty witnesses. Fourteen negative results had fast false, directly demonstrating why false is not a positive answer. All sampled expected labels agreed. No None or outer solver timeout occurred. The full source corpus was not run. Eight unmodified upstream library unit tests passed; their command output and separate lockfile are retained. [Native evidence][native], [unit log][unit-log], [upstream lock][upstream-lock].

Each named parse/solve child has a five-second outer limit; each sampled query has three seconds. The corpus sample has a 150-second loop budget with at most two final three-second calls after its last check. The native build runner has 180 seconds. Closure bounds are stated above. These limits guard research execution and prove no product decision at a cutoff. Native timings are observations of this Windows machine only. No peak-memory experiment or browser/WASM work ran here. The maximum reported combined fast/full native call in the final recording should be read from the raw results, not treated as a worst-case bound.

The first archive request for Popeye failed within bounded Python/curl download attempts. Smaller pinned documentation downloads succeeded. Python's certificate-store failure on the paper download used Windows curl's verified Schannel transport; TLS verification was not disabled. Build products, public source downloads and the final run's Cargo home are ignored inside this experiment. Initial build/unit-test setup also used the machine's existing Cargo package cache and fetched public Rayon dev dependencies there. No global service or toolchain target changed. [Acquisition code and transports][manifest], [reproduction notes][experiment-readme].

No production integration, browser-port work, provider call, secret, paid usage, account provisioning, tracker mutation, public message, push or further subagent occurred. All child calculations and compiler/test processes completed; no helper server or watcher was started. Public source caches and reproducible native binaries remain ignored for reruns. The other worker's paths and the baseline evidence were not modified.

[canonical]: ../experiments/exact-adjudication-coverage/canonical-comments.json
[manifest]: ../experiments/exact-adjudication-coverage/source-manifest.json
[review]: ../experiments/exact-adjudication-coverage/source-review.json
[native]: ../experiments/exact-adjudication-coverage/native-results.json
[lock]: ../experiments/exact-adjudication-coverage/probe/Cargo.lock
[probe-code]: ../experiments/exact-adjudication-coverage/probe/src/main.rs
[evidence-code]: ../experiments/exact-adjudication-coverage/run_evidence.py
[closure-code]: ../experiments/exact-adjudication-coverage/exact_closure.py
[certificate]: ../experiments/exact-adjudication-coverage/forced-cycle-certificate.json
[closure-results]: ../experiments/exact-adjudication-coverage/closure-results.json
[unit-log]: ../experiments/exact-adjudication-coverage/upstream-unit-tests.log
[upstream-lock]: ../experiments/exact-adjudication-coverage/upstream-Cargo.lock
[experiment-readme]: ../experiments/exact-adjudication-coverage/README.md
[checksums]: ../experiments/exact-adjudication-coverage/checksums.json
[paper]: https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.FUN.2022.2
[full-paper]: https://chasolver.org/FUN22-full.pdf
[fide]: https://handbook.fide.com/chapter/E012023
[api]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/lib.rs
[readme]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/README.md
[full]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/winnability/full.rs
[fast]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/winnability/fast.rs
[engine]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/search/engine.rs
[search-mod]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/search/mod.rs
[heuristics]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/search/heuristics.rs
[probes]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/search/probes.rs
[deduction]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/deduction/mod.rs
[analysis]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/deduction/analysis.rs
[saturation]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/deduction/saturation.rs
[geometry]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/deduction/utils.rs
[mirror]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/src/utils.rs
[tests]: https://github.com/miguel-ambrona/chasolver/blob/3484c7e65247003fac8705a9290dc2b5d0978b94/tests/integration.rs
[board-src]: https://docs.rs/crate/chess/3.2.0/source/src/board.rs
[builder-src]: https://docs.rs/crate/chess/3.2.0/source/src/board_builder.rs
[movegen]: https://docs.rs/crate/chess/3.2.0/source/src/movegen/movegen.rs
[piece-type]: https://docs.rs/crate/chess/3.2.0/source/src/movegen/piece_type.rs
[old-code]: https://github.com/miguel-ambrona/chasolver/blob/e53a24147cda65bec1f93e5c7cd1f5b10d67a4ef/src/cha.cpp
[old-search]: https://github.com/miguel-ambrona/chasolver/blob/e53a24147cda65bec1f93e5c7cd1f5b10d67a4ef/src/dynamic.cpp
[old-readme]: https://github.com/miguel-ambrona/chasolver/blob/e53a24147cda65bec1f93e5c7cd1f5b10d67a4ef/README.md
[popeye]: https://github.com/thomas-maeder/popeye/blob/006e480686bf167c2b79780984609aad746ce7a5/py-engl.txt
[popeye-readme]: https://github.com/thomas-maeder/popeye/blob/006e480686bf167c2b79780984609aad746ce7a5/README.md
[pychess]: https://github.com/niklasf/python-chess/blob/v1.11.2/chess/__init__.py
[syzygy]: https://github.com/niklasf/python-chess/blob/v1.11.2/chess/syzygy.py
