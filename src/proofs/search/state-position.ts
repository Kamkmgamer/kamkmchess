/** Reconstructs the canonical search FEN used for a repetition identity. */
export function proofSearchStatePositionFen(stateKey: string): string {
  const fields = stateKey.split(' ');
  if (fields.length !== 4 || fields.some((field) => field.length === 0)) {
    throw new TypeError('A proof-search state key must contain four nonempty fields.');
  }

  const sideToMove = fields[1];
  const enPassant = fields[3];
  const fullmove = sideToMove === 'w' && enPassant !== '-' ? '2' : '1';
  return `${stateKey} 0 ${fullmove}`;
}
