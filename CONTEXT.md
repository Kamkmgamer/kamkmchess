# Chess against AI models

A platform where people play chess against AI models that choose their own moves.

## Language

**Human player**:
A person playing chess against a model opponent.

**Model opponent**:
An AI model that plays one side of a chess game and chooses its own moves.

**AI connection**:
A human player's configured access to an AI provider or custom endpoint for their model opponents.

**Connected proxy**:
An AI connection through a human player's existing proxy, such as CLIProxyAPI.

**Model catalog**:
The model entries advertised through a human player's selected AI connection.

**Model family**:
A named group of related AI models, such as GPT, Claude, Gemini, Grok, or Kimi.

**Model switch**:
A change of model opponent within an existing chess match, which may also change the AI connection.

**Match conversation**:
The accumulated instructions, game inputs, and model replies on a match's current line of play, including any plans or reasoning the models returned.

**Match archive**:
The complete record of a match, including its current line of play, undone continuations, and earlier conversation segments.

**Undo**:
A takeback within an unfinished line of play that restores an earlier position and its corresponding match conversation without refunding elapsed clock time.

**Match clock**:
The remaining chess-playing time for one side of a timed match.

**Time control**:
The starting time for each side and any increment added after an accepted move.

**Loss on time**:
A final loss caused by a side exhausting its match clock when the opposing side can still possibly checkmate.

**Move attempt**:
A chess move proposed by a model opponent that may be legal or illegal. A formatting error alone does not establish an illegal move.

**Post-loss continuation**:
Unscored practice from the playable position at which a model lost. The original loss remains final.

**Practice segment**:
An unscored continuation with its own match conversation and clocks, while the source game's final result remains unchanged.

**Model resignation**:
An explicit refusal by a model opponent to make a move, resulting in a loss for that model.

**Custom starting position**:
A chess position chosen by the human player as the starting point for play against a model opponent.

**Guest game**:
A game saved for a human player without being associated with an account.

**Account game**:
A game associated with a human player's account for access across devices.
