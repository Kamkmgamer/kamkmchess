/** Keep provider payloads and technical diagnostics out of the playing interface. */
export function conciseError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/401|credential|api key|key again/i.test(detail)) return 'Check API key.';
  if (/403|permission/i.test(detail)) return 'Check access permissions.';
  if (/429|rate.limit/i.test(detail)) return 'Try again shortly.';
  if (/quota|credit|402/i.test(detail)) return 'Add provider credit.';
  if (/incompatible|contract|fixed coordinate/i.test(detail)) return 'Choose another model.';
  if (/FEN|position|king|pawn/i.test(detail)) return 'Check starting position.';
  if (/disclosure/i.test(detail)) return 'Allow connection first.';
  return 'Connection failed. Retry.';
}

/** A failed turn can have a healthy connection and an unusable provider reply. */
export function conciseTurnError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/HTTP 5\d\d/i.test(detail)) return 'Provider unavailable. Retry.';
  if (/HTTP (400|404|405|409|422)/i.test(detail)) return 'Provider rejected request.';
  if (/reply (incomplete|truncated)/i.test(detail)) return 'Reply incomplete. Retry.';
  if (/reply malformed|format|not interpretable/i.test(detail)) return 'Invalid reply. Retry.';
  if (/reply (failed|partial|empty)|stream/i.test(detail)) return 'Reply interrupted. Retry.';
  if (/capacity|request limit|token limit/i.test(detail)) return 'Request too large.';
  if (/could not be saved|storage|persistence/i.test(detail)) return 'Storage unavailable. Retry.';
  if (/fetch|network|failed to connect/i.test(detail)) return 'Connection failed. Retry.';
  const message = conciseError(error);
  return message === 'Connection failed. Retry.' ? 'Turn failed. Retry.' : message;
}
