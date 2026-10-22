-- The redaction of the personal model alias of a removed seat.
--
-- An ordinary account deletion keeps the shared game and anonymizes the
-- deleted owner as "Deleted player". The published snapshots of the game and
-- the declared control timeline of its seat kept the declared model label of
-- that seat, and the label may be an alias the owner registered for their own
-- model. The alias is personal, so a signed-out reader of the public replay
-- must not see it after the owner was deleted.
--
-- The redaction follows the policy of the seat anonymization: the label of the
-- removed seat is resolved as the label of an anonymized owner, so an
-- allowlisted public model name keeps its label and an alias the owner
-- registered becomes the neutral label "Custom model". The label of the
-- opponent is never touched.
--
-- Two things are redacted:
--
--   - the published payloads of the match: the public replay and the older
--     public projection of the match writer. They carry the declared control
--     of the participants, of the accepted moves and of the terminal action,
--     and the exact path of the removed seat is the only one that is
--     rewritten;
--   - the declared control timeline of the removed seat, which is the record
--     of the control that was in effect for every version of the seat.
--
-- The control timeline was append-only for the runtime role. The redaction is
-- the one rewrite the guard below accepts, and it is accepted only for a seat
-- that is already anonymized, only after a recorded anonymization marker of
-- the match, and only with the label the resolution publishes for an
-- anonymized owner. An earlier attribution of a live seat still cannot be
-- rewritten, and a row is never deleted.

-- Redacts the personal model alias of one seat in a published payload.
--
-- The payload is the public replay of a match or the older public projection
-- of the match writer. The function replaces the declared model label of the
-- participants, of the accepted moves and of the terminal action of the
-- given seat, and it keeps every other value of the payload exactly as it is.
--
-- The label is resolved as the label of an anonymized owner, so an
-- allowlisted public model name keeps its label and an alias the owner
-- registered for their own model becomes the neutral label.
CREATE OR REPLACE FUNCTION online_redact_seat_model_aliases(p_payload jsonb, p_seat text) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  redacted jsonb := p_payload;
  entries jsonb;
  element jsonb;
  control jsonb;
  label text;
  kind text;
  resolved text;
  index integer;
BEGIN
  IF p_payload IS NULL OR p_seat IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN p_payload;
  END IF;

  -- The participants of the payload.
  IF jsonb_typeof(redacted->'participants') = 'array' THEN
    entries := redacted->'participants';
    FOR index IN 0..jsonb_array_length(entries)-1 LOOP
      element := entries->index;
      IF element->>'seat' = p_seat THEN
        control := element->'control';
        label := control->>'modelLabel';
        IF label IS NOT NULL THEN
          kind := coalesce(control->>'kind', 'agent');
          resolved := online_resolve_public_model_label('account', 'anonymized', kind, label);
          IF resolved IS NOT NULL AND resolved <> label THEN
            element := jsonb_set(element, '{control,modelLabel}', to_jsonb(resolved), false);
            entries := jsonb_set(entries, ARRAY[index::text], element, false);
          END IF;
        END IF;
      END IF;
    END LOOP;
    redacted := jsonb_set(redacted, '{participants}', entries, false);
  END IF;

  -- The accepted moves of the payload.
  IF jsonb_typeof(redacted->'moves') = 'array' THEN
    entries := redacted->'moves';
    FOR index IN 0..jsonb_array_length(entries)-1 LOOP
      element := entries->index;
      IF element->>'seat' = p_seat THEN
        control := element->'control';
        label := control->>'modelLabel';
        IF label IS NOT NULL THEN
          kind := coalesce(control->>'kind', 'agent');
          resolved := online_resolve_public_model_label('account', 'anonymized', kind, label);
          IF resolved IS NOT NULL AND resolved <> label THEN
            element := jsonb_set(element, '{control,modelLabel}', to_jsonb(resolved), false);
            entries := jsonb_set(entries, ARRAY[index::text], element, false);
          END IF;
        END IF;
      END IF;
    END LOOP;
    redacted := jsonb_set(redacted, '{moves}', entries, false);
  END IF;

  -- The terminal action of the payload.
  IF jsonb_typeof(redacted->'terminal') = 'object' AND redacted->'terminal'->>'seat' = p_seat THEN
    control := redacted->'terminal'->'control';
    label := control->>'modelLabel';
    IF label IS NOT NULL THEN
      kind := coalesce(control->>'kind', 'agent');
      resolved := online_resolve_public_model_label('account', 'anonymized', kind, label);
      IF resolved IS NOT NULL AND resolved <> label THEN
        redacted := jsonb_set(redacted, '{terminal,control,modelLabel}', to_jsonb(resolved), false);
      END IF;
    END IF;
  END IF;

  RETURN redacted;
END
$$;

-- The declared control timeline accepts exactly one rewrite: the redaction of
-- the personal alias of an anonymized seat.
--
-- The identity of a row never changes, the control kind never changes and the
-- row is never deleted. The label of a row that belongs to a seat that is not
-- anonymized cannot be rewritten at all, and the label of an anonymized seat
-- can only become the label the resolution publishes for an anonymized
-- owner.
CREATE OR REPLACE FUNCTION online_guard_seat_control_timeline_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  resolved text;
BEGIN
  IF NEW.match_id <> OLD.match_id
     OR NEW.seat <> OLD.seat
     OR NEW.version <> OLD.version
     OR NEW.control_kind <> OLD.control_kind
     OR NEW.control_epoch <> OLD.control_epoch
     OR NEW.recorded_at <> OLD.recorded_at THEN
    RAISE EXCEPTION 'online seat control timeline identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.model_label IS DISTINCT FROM OLD.model_label THEN
    -- The redaction belongs to a seat whose owner was removed, so the seat is
    -- already anonymized and the match carries the marker of the removal.
    IF NOT EXISTS (
      SELECT 1 FROM online_seats s
      WHERE s.match_id = OLD.match_id AND s.seat = OLD.seat AND s.owner_id = 'anonymized'
    ) THEN
      RAISE EXCEPTION 'online seat control timeline redaction needs an anonymized seat' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM online_deletion_markers
      WHERE match_id = OLD.match_id AND marker_kind = 'account_anonymization'
    ) THEN
      RAISE EXCEPTION 'online seat control timeline redaction needs a deletion marker' USING ERRCODE = '55000';
    END IF;
    -- The label of the row becomes the label of an anonymized owner: an
    -- allowlisted public model name keeps its label and an alias the owner
    -- registered becomes the neutral label.
    resolved := online_resolve_public_model_label('account', 'anonymized', OLD.control_kind, OLD.model_label);
    IF NEW.model_label IS DISTINCT FROM resolved THEN
      RAISE EXCEPTION 'online seat control timeline redaction keeps the resolved model label' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS online_seat_control_timeline_guard ON online_seat_control_timeline;
CREATE TRIGGER online_seat_control_timeline_guard BEFORE UPDATE ON online_seat_control_timeline
  FOR EACH ROW EXECUTE FUNCTION online_guard_seat_control_timeline_update();

-- Runtime grants follow the KHA-65 pattern. The API role reads the timeline,
-- appends the new attribution and redacts the alias of a removed seat.
DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I.online_seat_control_timeline TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.online_seat_control_timeline FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- The redaction function reads the payload and rewrites it, so it holds no
-- table privilege of its own. The rules process keeps no privilege on it
-- either.
REVOKE ALL PRIVILEGES ON FUNCTION online_redact_seat_model_aliases(jsonb, text) FROM PUBLIC;
