-- Schema version 26. The public label of the server engine seat. Additive only.
--
-- An engine seat was always the browser fallback, so every engine control
-- resolved to the browser label. The server engine seat is owned by a guest
-- participant whose identifier starts with 'server-engine:', and it is named
-- 'Stockfish (server)'. The label is a fixed product name, so it is also kept
-- when it is presented on its own, which keeps the redaction of an anonymized
-- seat a no-op for it. Every other engine seat keeps the browser label.
CREATE OR REPLACE FUNCTION online_resolve_public_model_label(p_owner_kind text, p_owner_id text, p_control_kind text, p_model_label text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  resolved text;
BEGIN
  IF p_control_kind = 'human' THEN
    RETURN NULL;
  END IF;
  IF p_model_label IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_control_kind = 'engine' THEN
    IF (p_owner_kind = 'guest' AND p_owner_id LIKE 'server-engine:%') OR p_model_label = 'Stockfish (server)' THEN
      RETURN 'Stockfish (server)';
    END IF;
    RETURN 'Stockfish 19 Lite (browser)';
  END IF;
  SELECT a.public_label INTO resolved
    FROM online_public_model_allowlist a
    WHERE a.model_key = lower(btrim(p_model_label)) OR a.public_label = p_model_label
    LIMIT 1;
  IF resolved IS NOT NULL THEN
    RETURN resolved;
  END IF;
  IF p_owner_kind = 'account' AND p_owner_id IS NOT NULL AND p_owner_id <> 'anonymized' THEN
    SELECT l.public_label INTO resolved
      FROM online_account_public_labels l
      WHERE l.account_id = p_owner_id AND l.public_label = p_model_label AND l.revoked_at IS NULL
      LIMIT 1;
    IF resolved IS NOT NULL THEN
      RETURN resolved;
    END IF;
  END IF;
  RETURN online_neutral_model_label();
END
$$;
