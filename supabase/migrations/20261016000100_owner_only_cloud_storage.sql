begin;

create extension if not exists pgcrypto with schema extensions;
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated, service_role;
comment on schema app_private is 'Owner-bound cloud game storage. Authenticated clients use public RPCs only.';

create table app_private.cloud_games (
  game_id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  schema_version integer not null check (schema_version = 1),
  final_result jsonb,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (game_id, owner_id),
  unique (game_id, owner_id, schema_version)
);
create table app_private.cloud_game_ownership (
  game_id uuid primary key,
  owner_id uuid not null,
  schema_version integer not null check (schema_version = 1),
  ownership_epoch bigint not null check (ownership_epoch > 0),
  accepted_revision bigint not null check (accepted_revision > 0),
  events_through_sequence bigint check (events_through_sequence >= 0),
  chunks_through_sequence bigint check (chunks_through_sequence >= 0),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (game_id, owner_id, schema_version)
    references app_private.cloud_games(game_id, owner_id, schema_version) on delete cascade
);
create table app_private.cloud_game_checkpoints (
  game_id uuid not null, owner_id uuid not null, schema_version integer not null check (schema_version = 1),
  revision bigint not null check (revision > 0), ownership_epoch bigint not null check (ownership_epoch > 0),
  operation_id uuid not null, checkpoint_json text not null,
  payload_sha256 bytea not null check (pg_catalog.octet_length(payload_sha256) = 32),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (game_id, revision), unique (owner_id, operation_id),
  foreign key (game_id, owner_id, schema_version)
    references app_private.cloud_games(game_id, owner_id, schema_version) on delete cascade
);
create table app_private.cloud_game_archive_batches (
  game_id uuid not null, owner_id uuid not null, schema_version integer not null check (schema_version = 1),
  revision bigint not null check (revision > 0), ownership_epoch bigint not null check (ownership_epoch > 0),
  operation_id uuid not null,
  events_after_sequence bigint check (events_after_sequence >= 0), events_through_sequence bigint check (events_through_sequence >= 0),
  chunks_after_sequence bigint check (chunks_after_sequence >= 0), chunks_through_sequence bigint check (chunks_through_sequence >= 0),
  batch_bytes bytea not null, payload_sha256 bytea not null check (pg_catalog.octet_length(payload_sha256) = 32),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (game_id, revision), unique (owner_id, operation_id),
  foreign key (game_id, owner_id, schema_version)
    references app_private.cloud_games(game_id, owner_id, schema_version) on delete cascade,
  check (events_through_sequence is null or events_after_sequence is null or events_through_sequence >= events_after_sequence),
  check (chunks_through_sequence is null or chunks_after_sequence is null or chunks_through_sequence >= chunks_after_sequence)
);
create table app_private.cloud_game_archive_items (
  game_id uuid not null, owner_id uuid not null, archive_kind text not null check (archive_kind in ('event','chunk')),
  item_id text not null check (item_id <> ''), sequence bigint not null check (sequence >= 0), revision bigint not null check (revision > 0),
  primary key (game_id, archive_kind, item_id), unique (game_id, archive_kind, sequence),
  foreign key (game_id, owner_id) references app_private.cloud_games(game_id, owner_id) on delete cascade
);
create table app_private.cloud_game_outbox (
  owner_id uuid not null references auth.users(id) on delete cascade, operation_id uuid not null, game_id uuid not null,
  schema_version integer not null check (schema_version = 1),
  operation_kind text not null check (operation_kind in ('create','commit','takeover','delete')),
  request_digest bytea not null check (pg_catalog.octet_length(request_digest) = 32), response jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(), primary key(owner_id, operation_id)
);
create table app_private.cloud_game_tombstones (
  game_id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
  schema_version integer not null check (schema_version = 1), deleted_revision bigint not null check (deleted_revision > 0),
  deleted_epoch bigint not null check (deleted_epoch > 0), deletion_operation_id uuid not null,
  deleted_at timestamptz not null default pg_catalog.clock_timestamp()
);
create index cloud_game_checkpoints_owner_game_idx on app_private.cloud_game_checkpoints(owner_id, game_id, revision);
create index cloud_game_archive_batches_owner_game_idx on app_private.cloud_game_archive_batches(owner_id, game_id, revision);
create index cloud_game_archive_items_owner_game_idx on app_private.cloud_game_archive_items(owner_id, game_id, archive_kind, sequence);
create index cloud_game_outbox_owner_game_idx on app_private.cloud_game_outbox(owner_id, game_id, created_at);
create index cloud_game_tombstones_owner_idx on app_private.cloud_game_tombstones(owner_id, deleted_at);

comment on table app_private.cloud_games is 'Owner-bound metadata and the semantic immutable final result, if accepted.';
comment on table app_private.cloud_game_ownership is 'Current cloud fence, sparse accepted local revision, and archive sequence watermarks.';
comment on table app_private.cloud_game_checkpoints is 'Exact allowlisted GameCheckpointV1 JSON text at each accepted local revision.';
comment on table app_private.cloud_game_archive_batches is 'Exact versioned CloudArchiveBatchV1 bytes and outer digest at each accepted revision.';
comment on table app_private.cloud_game_archive_items is 'Owner-scoped archive ID/sequence uniqueness metadata; source records remain in exact batch bytes.';
comment on table app_private.cloud_game_outbox is 'Operation identity and digest ledger. Deletion replaces responses with payload-free receipts.';
comment on table app_private.cloud_game_tombstones is 'Permanent owner deletion markers. A tombstoned game UUID cannot be recreated.';

alter table app_private.cloud_games enable row level security; alter table app_private.cloud_games force row level security;
alter table app_private.cloud_game_ownership enable row level security; alter table app_private.cloud_game_ownership force row level security;
alter table app_private.cloud_game_checkpoints enable row level security; alter table app_private.cloud_game_checkpoints force row level security;
alter table app_private.cloud_game_archive_batches enable row level security; alter table app_private.cloud_game_archive_batches force row level security;
alter table app_private.cloud_game_archive_items enable row level security; alter table app_private.cloud_game_archive_items force row level security;
alter table app_private.cloud_game_outbox enable row level security; alter table app_private.cloud_game_outbox force row level security;
alter table app_private.cloud_game_tombstones enable row level security; alter table app_private.cloud_game_tombstones force row level security;
create policy owner_access on app_private.cloud_games for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy owner_access on app_private.cloud_game_ownership for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy owner_access on app_private.cloud_game_checkpoints for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy owner_access on app_private.cloud_game_archive_batches for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy owner_access on app_private.cloud_game_archive_items for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy owner_access on app_private.cloud_game_outbox for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy owner_access on app_private.cloud_game_tombstones for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
revoke all on all tables in schema app_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema app_private from public, anon, authenticated, service_role;
alter default privileges in schema app_private revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema app_private revoke all on sequences from public, anon, authenticated, service_role;

create function app_private.assert_exact_keys(p_value jsonb,p_keys text[],p_path text) returns void
language plpgsql immutable security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare v_count integer; v_expected integer;
begin
  if pg_catalog.jsonb_typeof(p_value)<>'object' then raise exception '% must be an object',p_path using errcode='22023'; end if;
  select count(*)::integer into v_count from pg_catalog.jsonb_object_keys(p_value);
  select count(distinct k)::integer into v_expected from pg_catalog.unnest(p_keys) as keys(k);
  if v_count<>v_expected or exists(select 1 from pg_catalog.jsonb_object_keys(p_value) as actual(key) where not (actual.key=any(p_keys)))
    or exists(select 1 from pg_catalog.unnest(p_keys) as expected(key) where not (p_value ? expected.key)) then
    raise exception '% has unsupported or missing fields',p_path using errcode='22023';
  end if;
end;
$function$;
create function app_private.assert_string(p_value jsonb,p_path text,p_nonempty boolean default false) returns void
language plpgsql immutable security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
begin
  if pg_catalog.jsonb_typeof(p_value)<>'string' or (p_nonempty and pg_catalog.btrim(p_value #>> '{}')='') then raise exception '% must be a string',p_path using errcode='22023'; end if;
end;
$function$;
create function app_private.assert_number(p_value jsonb,p_path text) returns void
language plpgsql immutable security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare v_float double precision;
begin
  if pg_catalog.jsonb_typeof(p_value)<>'number' then raise exception '% must be a number',p_path using errcode='22023'; end if;
  begin v_float:=(p_value #>> '{}')::double precision; exception when others then raise exception '% must be a finite number',p_path using errcode='22023'; end;
  if v_float='Infinity'::double precision or v_float='-Infinity'::double precision or v_float='NaN'::double precision then
    raise exception '% must be a finite number',p_path using errcode='22023';
  end if;
end;
$function$;
create function app_private.safe_integer(p_value jsonb,p_path text,p_min bigint,p_allow_null boolean default false) returns bigint
language plpgsql immutable security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare v numeric;
begin
  if p_value='null'::jsonb and p_allow_null then return null; end if;
  if pg_catalog.jsonb_typeof(p_value)<>'number' then raise exception '% must be an integer',p_path using errcode='22023'; end if;
  begin v := (p_value #>> '{}')::numeric; exception when others then raise exception '% must be an integer',p_path using errcode='22023'; end;
  if v<>pg_catalog.trunc(v) or v<p_min::numeric or v>9007199254740991::numeric then raise exception '% is outside the supported integer range',p_path using errcode='22023'; end if;
  return v::bigint;
end;
$function$;
create function app_private.assert_string_array(p_value jsonb,p_path text) returns void
language plpgsql immutable security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare i jsonb;
begin
  if pg_catalog.jsonb_typeof(p_value)<>'array' then raise exception '% must be an array',p_path using errcode='22023'; end if;
  for i in select value from pg_catalog.jsonb_array_elements(p_value) loop perform app_private.assert_string(i,p_path||'[]'); end loop;
end;
$function$;
create function app_private.assert_decimal_string(p_value jsonb,p_path text,p_minimum_one boolean default false) returns void
language plpgsql immutable security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare v_text text;
begin
  perform app_private.assert_string(p_value,p_path,true);
  v_text:=p_value #>> '{}';
  if v_text !~ '^(0|[1-9][0-9]*)$' or (p_minimum_one and v_text='0') then raise exception '% must be an exact non-negative decimal string',p_path using errcode='22023'; end if;
end;
$function$;
create function app_private.assert_no_duplicate_json_keys(p_value json) returns void
language plpgsql immutable security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare child json; key_name text;
begin
  case pg_catalog.json_typeof(p_value)
    when 'object' then
      select key into key_name from pg_catalog.json_each(p_value) group by key having count(*)>1 limit 1;
      if found then raise exception 'DTO contains duplicate object keys' using errcode='22023'; end if;
      for child in select value from pg_catalog.json_each(p_value) loop perform app_private.assert_no_duplicate_json_keys(child); end loop;
    when 'array' then for child in select value from pg_catalog.json_array_elements(p_value) loop perform app_private.assert_no_duplicate_json_keys(child); end loop;
    else null;
  end case;
end;
$function$;
create function app_private.validate_result_json(p jsonb,p_path text) returns void
language plpgsql immutable security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare k text; r text;
begin
  if jsonb_typeof(p)<>'object' then raise exception '% must be a result object',p_path using errcode='22023'; end if;
  k := p->>'kind';
  if k='unresolved' then perform app_private.assert_exact_keys(p,array['kind'],p_path); return;
  elsif k='pending-adjudication' then
    perform app_private.assert_exact_keys(p,array['kind','reason','eventId','eventAtMs','activeClockDeadlineMs'],p_path);
    if p->>'reason' is null or p->>'reason' not in ('checkmate','timeout','dead-position','threefold-repetition','fifty-move-rule') then raise exception '% has an unsupported pending reason',p_path using errcode='22023'; end if;
    perform app_private.assert_string(p->'eventId',p_path||'.eventId',true); perform app_private.assert_number(p->'eventAtMs',p_path||'.eventAtMs');
    if p->'activeClockDeadlineMs'<>'null'::jsonb then perform app_private.assert_number(p->'activeClockDeadlineMs',p_path||'.activeClockDeadlineMs'); end if; return;
  elsif k='final' then
    perform app_private.assert_exact_keys(p,array['kind','winner','reason','eventId','decidedAtMs'],p_path);
    if p->>'winner' is null or p->>'winner' not in ('white','black','draw') then raise exception '% has an unsupported winner',p_path using errcode='22023'; end if;
    r := p->>'reason';
    if r is null or r not in ('checkmate','timeout','dead-position','threefold-repetition','fifty-move-rule','resignation','illegal-move','stalemate') then raise exception '% has an unsupported final reason',p_path using errcode='22023'; end if;
    if r='stalemate' and p->>'winner'<>'draw' then raise exception '% stalemate result must be a draw',p_path using errcode='22023'; end if;
    perform app_private.assert_string(p->'eventId',p_path||'.eventId',true); perform app_private.assert_number(p->'decidedAtMs',p_path||'.decidedAtMs'); return;
  end if;
  raise exception '% has an unsupported result kind',p_path using errcode='22023';
end;
$function$;

create function app_private.validate_game_checkpoint(p_payload text,p_game_id uuid,p_owner uuid,p_epoch bigint) returns jsonb
language plpgsql immutable security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare
  raw json; v jsonb; i jsonb; line jsonb; player jsonb; anchor jsonb;
begin
  if p_payload is null or btrim(p_payload)='' then raise exception 'game checkpoint is required' using errcode='22023'; end if;
  begin raw := p_payload::json; exception when others then raise exception 'game checkpoint is not valid JSON' using errcode='22023'; end;
  perform app_private.assert_no_duplicate_json_keys(raw); v := p_payload::jsonb;
  perform app_private.assert_exact_keys(v,array['schemaVersion','gameId','namespace','revision','ownershipEpoch','segmentId','positionRevision','requestGeneration','analysisGeneration','updatedAtMs','rules','history','clocks','budgets','selections','archive','result','practice','extensions'],'checkpoint');
  if v->'schemaVersion' is distinct from '1'::jsonb or v->>'gameId' is distinct from p_game_id::text then raise exception 'game checkpoint identity or version is invalid' using errcode='22023'; end if;
  if v#>>'{namespace,kind}'='guest' then
    perform app_private.assert_exact_keys(v->'namespace',array['kind'],'checkpoint.namespace');
    raise exception 'checkpoint namespace is unavailable to this user' using errcode='42501';
  elsif v#>>'{namespace,kind}' is distinct from 'account' then
    raise exception 'checkpoint namespace is invalid' using errcode='22023';
  end if;
  perform app_private.assert_exact_keys(v->'namespace',array['kind','accountId'],'checkpoint.namespace');
  if v#>>'{namespace,accountId}' is distinct from p_owner::text then raise exception 'checkpoint namespace is unavailable to this user' using errcode='42501'; end if;
  perform app_private.safe_integer(v->'revision','checkpoint.revision',1);
  if app_private.safe_integer(v->'ownershipEpoch','checkpoint.ownershipEpoch',0)<>p_epoch then raise exception 'checkpoint ownership epoch does not match the accepted write' using errcode='22023'; end if;
  perform app_private.assert_string(v->'segmentId','checkpoint.segmentId',true);
  perform app_private.safe_integer(v->'positionRevision','checkpoint.positionRevision',0);
  perform app_private.safe_integer(v->'requestGeneration','checkpoint.requestGeneration',0);
  perform app_private.safe_integer(v->'analysisGeneration','checkpoint.analysisGeneration',0);
  perform app_private.assert_number(v->'updatedAtMs','checkpoint.updatedAtMs');

  perform app_private.assert_exact_keys(v->'rules',array['variant','startingFen','currentFen','sideToMove','castlingRights','enPassantSquare','halfmoveClock','fullmoveNumber','repetitionLedger','moves'],'checkpoint.rules');
  if v#>>'{rules,variant}' is distinct from 'orthodox' or v#>>'{rules,sideToMove}' is null or v#>>'{rules,sideToMove}' not in ('white','black') then raise exception 'checkpoint.rules has unsupported values' using errcode='22023'; end if;
  perform app_private.assert_string(v#>'{rules,startingFen}','checkpoint.rules.startingFen'); perform app_private.assert_string(v#>'{rules,currentFen}','checkpoint.rules.currentFen');
  perform app_private.assert_string(v#>'{rules,castlingRights}','checkpoint.rules.castlingRights');
  if v#>'{rules,enPassantSquare}'<>'null'::jsonb then perform app_private.assert_string(v#>'{rules,enPassantSquare}','checkpoint.rules.enPassantSquare'); end if;
  perform app_private.assert_decimal_string(v#>'{rules,halfmoveClock}','checkpoint.rules.halfmoveClock'); perform app_private.assert_decimal_string(v#>'{rules,fullmoveNumber}','checkpoint.rules.fullmoveNumber',true);
  perform app_private.assert_exact_keys(v#>'{rules,repetitionLedger}',array['version','positions'],'checkpoint.rules.repetitionLedger');
  if v#>>'{rules,repetitionLedger,version}' is distinct from '1' or jsonb_typeof(v#>'{rules,repetitionLedger,positions}')<>'array' then raise exception 'checkpoint repetition ledger is invalid' using errcode='22023'; end if;
  for i in select value from jsonb_array_elements(v#>'{rules,repetitionLedger,positions}') loop
    perform app_private.assert_exact_keys(i,array['identity','occurrences'],'checkpoint.rules.repetitionLedger.positions[]');
    perform app_private.assert_string(i->'identity','checkpoint.rules.repetitionLedger.positions[].identity',true);
    perform app_private.assert_decimal_string(i->'occurrences','checkpoint.rules.repetitionLedger.positions[].occurrences',true);
  end loop;
  if jsonb_typeof(v#>'{rules,moves}')<>'array' then raise exception 'checkpoint.rules.moves must be an array' using errcode='22023'; end if;
  for i in select value from jsonb_array_elements(v#>'{rules,moves}') loop
    perform app_private.assert_exact_keys(i,array['moveId','from','to','promotion','san','fenBefore','fenAfter','eventId'],'checkpoint.rules.moves[]');
    perform app_private.assert_string(i->'moveId','checkpoint.rules.moves[].moveId',true); perform app_private.assert_string(i->'from','checkpoint.rules.moves[].from');
    perform app_private.assert_string(i->'to','checkpoint.rules.moves[].to'); if i->'promotion'<>'null'::jsonb then perform app_private.assert_string(i->'promotion','checkpoint.rules.moves[].promotion'); end if;
    perform app_private.assert_string(i->'san','checkpoint.rules.moves[].san'); perform app_private.assert_string(i->'fenBefore','checkpoint.rules.moves[].fenBefore');
    perform app_private.assert_string(i->'fenAfter','checkpoint.rules.moves[].fenAfter'); perform app_private.assert_string(i->'eventId','checkpoint.rules.moves[].eventId',true);
  end loop;

  perform app_private.assert_exact_keys(v->'history',array['currentSegmentId','segments','messages'],'checkpoint.history');
  perform app_private.assert_string(v#>'{history,currentSegmentId}','checkpoint.history.currentSegmentId',true);
  if jsonb_typeof(v#>'{history,segments}')<>'array' or jsonb_typeof(v#>'{history,messages}')<>'array' then raise exception 'checkpoint history arrays are invalid' using errcode='22023'; end if;
  for i in select value from jsonb_array_elements(v#>'{history,segments}') loop
    perform app_private.assert_exact_keys(i,array['segmentId','providerId','modelRoutingId','connectionRevision','startedAtMs','messageIds'],'checkpoint.history.segments[]');
    perform app_private.assert_string(i->'segmentId','history.segments[].segmentId',true); perform app_private.assert_string(i->'providerId','history.segments[].providerId');
    perform app_private.assert_string(i->'modelRoutingId','history.segments[].modelRoutingId'); perform app_private.safe_integer(i->'connectionRevision','history.segments[].connectionRevision',0);
    perform app_private.assert_number(i->'startedAtMs','history.segments[].startedAtMs'); perform app_private.assert_string_array(i->'messageIds','history.segments[].messageIds');
  end loop;
  for i in select value from jsonb_array_elements(v#>'{history,messages}') loop
    perform app_private.assert_exact_keys(i,array['messageId','segmentId','lineId','role','content','eventIds','disposition'],'checkpoint.history.messages[]');
    perform app_private.assert_string(i->'messageId','history.messages[].messageId',true); perform app_private.assert_string(i->'segmentId','history.messages[].segmentId',true);
    perform app_private.assert_string(i->'lineId','history.messages[].lineId',true);
    if i->>'role' is null or i->>'role' not in ('system','developer','user','assistant','tool','function') then raise exception 'history message role is invalid' using errcode='22023'; end if;
    perform app_private.assert_string(i->'content','history.messages[].content'); perform app_private.assert_string_array(i->'eventIds','history.messages[].eventIds');
    if i->>'disposition' is null or i->>'disposition' not in ('retained','discarded') then raise exception 'history message disposition is invalid' using errcode='22023'; end if;
  end loop;

  perform app_private.assert_exact_keys(v->'clocks',array['schemaVersion','timeControl','banksAtAnchor','activeSide','anchor','lastReconciledAtMs'],'checkpoint.clocks');
  if v#>>'{clocks,schemaVersion}' is distinct from '1' then raise exception 'clock schema version is unsupported' using errcode='22023'; end if;
  perform app_private.assert_exact_keys(v#>'{clocks,timeControl}',array['startingTimeMs','incrementMs'],'clocks.timeControl');
  perform app_private.assert_number(v#>'{clocks,timeControl,startingTimeMs}','clocks.timeControl.startingTimeMs'); perform app_private.assert_number(v#>'{clocks,timeControl,incrementMs}','clocks.timeControl.incrementMs');
  perform app_private.assert_exact_keys(v#>'{clocks,banksAtAnchor}',array['whiteMs','blackMs'],'clocks.banksAtAnchor');
  perform app_private.assert_number(v#>'{clocks,banksAtAnchor,whiteMs}','clocks.banksAtAnchor.whiteMs'); perform app_private.assert_number(v#>'{clocks,banksAtAnchor,blackMs}','clocks.banksAtAnchor.blackMs');
  if v#>'{clocks,activeSide}'<>'null'::jsonb and v#>>'{clocks,activeSide}' not in ('white','black') then raise exception 'clock active side is invalid' using errcode='22023'; end if;
  anchor := v#>'{clocks,anchor}';
  if anchor='null'::jsonb then if v#>'{clocks,activeSide}'<>'null'::jsonb then raise exception 'paused clock fields disagree' using errcode='22023'; end if;
  else
    if v#>'{clocks,activeSide}'='null'::jsonb then raise exception 'running clock fields disagree' using errcode='22023'; end if;
    if anchor ? 'hostOffsetMs' then perform app_private.assert_exact_keys(anchor,array['monotonicMs','wallTimeMs','hostOffsetMs'],'clocks.anchor'); else perform app_private.assert_exact_keys(anchor,array['monotonicMs','wallTimeMs'],'clocks.anchor'); end if;
    perform app_private.assert_number(anchor->'monotonicMs','clocks.anchor.monotonicMs'); perform app_private.assert_number(anchor->'wallTimeMs','clocks.anchor.wallTimeMs');
    if anchor ? 'hostOffsetMs' then perform app_private.assert_number(anchor->'hostOffsetMs','clocks.anchor.hostOffsetMs'); end if;
  end if;
  perform app_private.assert_number(v#>'{clocks,lastReconciledAtMs}','clocks.lastReconciledAtMs');

  perform app_private.assert_exact_keys(v->'budgets',array['formattingCorrectionsRemaining','illegalMoveAttemptsRemaining','manualRetriesBySide'],'checkpoint.budgets');
  perform app_private.safe_integer(v#>'{budgets,formattingCorrectionsRemaining}','budgets.formattingCorrectionsRemaining',0);
  perform app_private.assert_exact_keys(v#>'{budgets,illegalMoveAttemptsRemaining}',array['white','black'],'budgets.illegalMoveAttemptsRemaining');
  perform app_private.safe_integer(v#>'{budgets,illegalMoveAttemptsRemaining,white}','budgets.illegalMoveAttemptsRemaining.white',0); perform app_private.safe_integer(v#>'{budgets,illegalMoveAttemptsRemaining,black}','budgets.illegalMoveAttemptsRemaining.black',0);
  perform app_private.assert_exact_keys(v#>'{budgets,manualRetriesBySide}',array['white','black'],'budgets.manualRetriesBySide');
  perform app_private.safe_integer(v#>'{budgets,manualRetriesBySide,white}','budgets.manualRetriesBySide.white',0); perform app_private.safe_integer(v#>'{budgets,manualRetriesBySide,black}','budgets.manualRetriesBySide.black',0);

  perform app_private.assert_exact_keys(v->'selections',array['players'],'checkpoint.selections'); perform app_private.assert_exact_keys(v#>'{selections,players}',array['white','black'],'selections.players');
  for player in select value from jsonb_each(v#>'{selections,players}') loop
    if player->>'kind'='human' then perform app_private.assert_exact_keys(player,array['kind'],'selection.player');
    elsif player->>'kind'='model' then
      perform app_private.assert_exact_keys(player,array['kind','providerId','connectionId','configurationRevision','modelRoutingId','protocol','diagnostic'],'selection.player');
      perform app_private.assert_string(player->'providerId','selection.providerId'); perform app_private.assert_string(player->'connectionId','selection.connectionId',true);
      perform app_private.safe_integer(player->'configurationRevision','selection.configurationRevision',0); perform app_private.assert_string(player->'modelRoutingId','selection.modelRoutingId',true);
      if player->>'protocol' is null or player->>'protocol' not in ('chat-completions','responses','messages','custom')
        or player->>'diagnostic' is null or player->>'diagnostic' not in ('not-run','passed-current-session','failed','unknown') then raise exception 'model selection values are invalid' using errcode='22023'; end if;
    else raise exception 'selection kind is invalid' using errcode='22023'; end if;
  end loop;

  perform app_private.assert_exact_keys(v->'archive',array['egressStatus','currentLine','discardedLines'],'checkpoint.archive');
  if v#>>'{archive,egressStatus}' is distinct from 'eligible' then raise exception 'credential-quarantined game data cannot be uploaded' using errcode='22023'; end if;
  perform app_private.assert_exact_keys(v#>'{archive,currentLine}',array['lineId','eventIds'],'archive.currentLine');
  perform app_private.assert_string(v#>'{archive,currentLine,lineId}','archive.currentLine.lineId',true); perform app_private.assert_string_array(v#>'{archive,currentLine,eventIds}','archive.currentLine.eventIds');
  if jsonb_typeof(v#>'{archive,discardedLines}')<>'array' then raise exception 'archive.discardedLines must be an array' using errcode='22023'; end if;
  for line in select value from jsonb_array_elements(v#>'{archive,discardedLines}') loop
    perform app_private.assert_exact_keys(line,array['lineId','eventIds','discardedAtRevision','reason'],'archive.discardedLines[]');
    perform app_private.assert_string(line->'lineId','archive.discardedLines[].lineId',true); perform app_private.assert_string_array(line->'eventIds','archive.discardedLines[].eventIds');
    perform app_private.safe_integer(line->'discardedAtRevision','archive.discardedLines[].discardedAtRevision',1);
    if line->>'reason' is null or line->>'reason' not in ('undo','branch','replacement') then raise exception 'discarded line reason is invalid' using errcode='22023'; end if;
  end loop;
  perform app_private.validate_result_json(v->'result','checkpoint.result');
  perform app_private.assert_exact_keys(v->'practice',array['mode','scored','sourceGameId','sourcePositionFen','originalResult'],'checkpoint.practice');
  if v#>>'{practice,mode}' is null or v#>>'{practice,mode}' not in ('ordinary','practice') or jsonb_typeof(v#>'{practice,scored}')<>'boolean' then raise exception 'practice fields are invalid' using errcode='22023'; end if;
  if v#>'{practice,sourceGameId}'<>'null'::jsonb then perform app_private.assert_string(v#>'{practice,sourceGameId}','practice.sourceGameId'); end if;
  if v#>'{practice,sourcePositionFen}'<>'null'::jsonb then perform app_private.assert_string(v#>'{practice,sourcePositionFen}','practice.sourcePositionFen'); end if;
  if v#>'{practice,originalResult}'<>'null'::jsonb then
    perform app_private.validate_result_json(v#>'{practice,originalResult}','practice.originalResult');
    if v#>>'{practice,originalResult,kind}'<>'final' then raise exception 'practice originalResult must be final or null' using errcode='22023'; end if;
  end if;
  if jsonb_typeof(v->'extensions')<>'object' then raise exception 'checkpoint.extensions must be an object' using errcode='22023'; end if;
  if v->'extensions'<>'{}'::jsonb then raise exception 'unregistered checkpoint extensions are not accepted' using errcode='22023'; end if;
  return v;
end;
$function$;

create function app_private.validate_archive_batch(
  p_base64 text,p_sha text,p_game uuid,p_base_revision bigint,p_base_epoch bigint,p_checkpoint_revision bigint,
  p_events_after bigint,p_chunks_after bigint
) returns jsonb language plpgsql immutable security definer
set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare
  bytes bytea; body text; raw json; v jsonb; i jsonb; chunk_bytes bytea;
  seq bigint; previous_seq bigint; last_event bigint; last_chunk bigint;
  events_through bigint; chunks_through bigint; expected_base jsonb;
begin
  if p_base64 is null or p_sha is null or p_sha !~ '^[a-f0-9]{64}$' then raise exception 'archive batch encoding or digest is invalid' using errcode='22023'; end if;
  begin
    bytes := decode(p_base64,'base64');
    if encode(extensions.digest(bytes,'sha256'),'hex')<>p_sha then raise exception 'digest mismatch'; end if;
    body := convert_from(bytes,'UTF8'); raw := body::json;
  exception when others then raise exception 'archive batch encoding or digest is invalid' using errcode='22023'; end;
  perform app_private.assert_no_duplicate_json_keys(raw); v := body::jsonb;
  perform app_private.assert_exact_keys(v,array['format','schemaVersion','gameId','baseRevision','baseOwnershipEpoch','checkpointRevision','eventsAfterSequence','eventsThroughSequence','chunksAfterSequence','chunksThroughSequence','events','chunks'],'archive batch');
  if v->>'format' is distinct from 'kamkmchess.cloud-archive-batch' or v->'schemaVersion' is distinct from '1'::jsonb
    or v->>'gameId' is distinct from p_game::text then raise exception 'archive batch identity or version is invalid' using errcode='22023'; end if;
  if p_base_revision is null then expected_base:='null'::jsonb; else expected_base:=to_jsonb(p_base_revision); end if;
  if v->'baseRevision' is distinct from expected_base or safe_integer(v->'baseOwnershipEpoch','archive batch.baseOwnershipEpoch',0)<>p_base_epoch
    or safe_integer(v->'checkpointRevision','archive batch.checkpointRevision',1)<>p_checkpoint_revision then raise exception 'archive batch base or checkpoint revision is invalid' using errcode='22023'; end if;
  if safe_integer(v->'eventsAfterSequence','archive batch.eventsAfterSequence',0,true) is distinct from p_events_after
    or safe_integer(v->'chunksAfterSequence','archive batch.chunksAfterSequence',0,true) is distinct from p_chunks_after then raise exception 'archive batch sequence cursor is stale' using errcode='40001'; end if;
  events_through:=safe_integer(v->'eventsThroughSequence','archive batch.eventsThroughSequence',0,true);
  chunks_through:=safe_integer(v->'chunksThroughSequence','archive batch.chunksThroughSequence',0,true);
  if jsonb_typeof(v->'events')<>'array' or jsonb_typeof(v->'chunks')<>'array' then raise exception 'archive batch arrays are required' using errcode='22023'; end if;

  previous_seq:=null; last_event:=null;
  for i in select value from jsonb_array_elements(v->'events') loop
    perform assert_exact_keys(i,array['eventId','gameId','sequence','segmentId','kind','occurredAtMs','receiveState','egressStatus','payload','chunkIds'],'archive events[]');
    perform assert_string(i->'eventId','eventId',true); perform assert_string(i->'gameId','event.gameId',true);
    if i->>'gameId'<>p_game::text then raise exception 'archive event game ID does not match' using errcode='22023'; end if;
    seq:=safe_integer(i->'sequence','event.sequence',0);
    if previous_seq is not null and seq<=previous_seq then raise exception 'archive event sequences must be strictly increasing' using errcode='22023'; end if;
    if p_events_after is not null and seq<=p_events_after then raise exception 'archive event is outside its declared range' using errcode='22023'; end if;
    if events_through is null or seq>events_through then raise exception 'archive event is outside its declared range' using errcode='22023'; end if;
    previous_seq:=seq; last_event:=seq;
    perform assert_string(i->'segmentId','event.segmentId',true); perform assert_string(i->'kind','event.kind',true); perform assert_number(i->'occurredAtMs','event.occurredAtMs');
    if i->>'receiveState' is null or i->>'receiveState' not in ('complete','partial') or i->>'egressStatus' is distinct from 'eligible' then raise exception 'archive event state is invalid or quarantined' using errcode='22023'; end if;
    perform assert_string_array(i->'chunkIds','event.chunkIds');
    if not (i ? 'payload') then raise exception 'archive event payload is required' using errcode='22023'; end if;
  end loop;
  if jsonb_array_length(v->'events')=0 then
    if events_through is distinct from p_events_after then raise exception 'empty event range must retain its watermark' using errcode='22023'; end if;
  elsif last_event is distinct from events_through then raise exception 'event range must end at its last sequence' using errcode='22023'; end if;

  previous_seq:=null; last_chunk:=null;
  for i in select value from jsonb_array_elements(v->'chunks') loop
    perform assert_exact_keys(i,array['chunkId','gameId','sequence','receivedAtMs','isFinal','egressStatus','bytesBase64','sha256'],'archive chunks[]');
    perform assert_string(i->'chunkId','chunkId',true); perform assert_string(i->'gameId','chunk.gameId',true);
    if i->>'gameId'<>p_game::text then raise exception 'archive chunk game ID does not match' using errcode='22023'; end if;
    seq:=safe_integer(i->'sequence','chunk.sequence',0);
    if previous_seq is not null and seq<=previous_seq then raise exception 'archive chunk sequences must be strictly increasing' using errcode='22023'; end if;
    if p_chunks_after is not null and seq<=p_chunks_after then raise exception 'archive chunk is outside its declared range' using errcode='22023'; end if;
    if chunks_through is null or seq>chunks_through then raise exception 'archive chunk is outside its declared range' using errcode='22023'; end if;
    previous_seq:=seq; last_chunk:=seq;
    perform assert_number(i->'receivedAtMs','chunk.receivedAtMs');
    if jsonb_typeof(i->'isFinal')<>'boolean' or i->>'egressStatus' is distinct from 'eligible' then raise exception 'archive chunk state is invalid or quarantined' using errcode='22023'; end if;
    perform assert_string(i->'bytesBase64','chunk.bytesBase64'); perform assert_string(i->'sha256','chunk.sha256');
    if i->>'sha256' !~ '^[a-f0-9]{64}$' then raise exception 'archive chunk digest is invalid' using errcode='22023'; end if;
    begin chunk_bytes:=decode(i->>'bytesBase64','base64'); exception when others then raise exception 'archive chunk encoding is invalid' using errcode='22023'; end;
    if encode(extensions.digest(chunk_bytes,'sha256'),'hex')<>(i->>'sha256') then raise exception 'archive chunk digest does not match its bytes' using errcode='22023'; end if;
  end loop;
  if jsonb_array_length(v->'chunks')=0 then
    if chunks_through is distinct from p_chunks_after then raise exception 'empty chunk range must retain its watermark' using errcode='22023'; end if;
  elsif last_chunk is distinct from chunks_through then raise exception 'chunk range must end at its last sequence' using errcode='22023'; end if;
  if p_events_after is not null and events_through is not null and events_through<p_events_after then raise exception 'event watermark moved backward' using errcode='22023'; end if;
  if p_chunks_after is not null and chunks_through is not null and chunks_through<p_chunks_after then raise exception 'chunk watermark moved backward' using errcode='22023'; end if;
  return v;
end;
$function$;

create function app_private.request_digest(p jsonb) returns bytea language sql immutable strict security definer
set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
  select extensions.digest(convert_to(p::text,'UTF8'),'sha256');
$function$;
create function app_private.lock_operation(p_owner uuid,p_operation uuid) returns void language sql volatile security definer
set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
  select pg_advisory_xact_lock(hashtextextended('operation:'||p_owner::text||':'||p_operation::text,41041));
$function$;
create function app_private.lock_game(p_game uuid) returns void language sql volatile security definer
set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
  select pg_advisory_xact_lock(hashtextextended('game:'||p_game::text,41042));
$function$;
create function app_private.lock_game_shared(p_game uuid) returns void language sql volatile security definer
set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
  select pg_advisory_xact_lock_shared(hashtextextended('game:'||p_game::text,41042));
$function$;
create function app_private.previous_response(p_owner uuid,p_operation uuid,p_digest bytea) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare old_digest bytea; old_response jsonb;
begin
  select request_digest,response into old_digest,old_response from app_private.cloud_game_outbox where owner_id=p_owner and operation_id=p_operation for update;
  if not found then return null; end if;
  if old_digest<>p_digest then raise exception 'operation ID was reused with different input' using errcode='23505'; end if;
  return old_response;
end;
$function$;
create function app_private.store_operation(p_owner uuid,p_game uuid,p_operation uuid,p_kind text,p_digest bytea,p_response jsonb) returns void
language sql volatile security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
  insert into app_private.cloud_game_outbox(owner_id,operation_id,game_id,schema_version,operation_kind,request_digest,response)
  values(p_owner,p_operation,p_game,1,p_kind,p_digest,p_response);
$function$;
create function app_private.insert_archive_items(p_game uuid,p_owner uuid,p_revision bigint,p_batch jsonb) returns void
language plpgsql volatile security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare i jsonb;
begin
  for i in select value from jsonb_array_elements(p_batch->'events') loop
    insert into app_private.cloud_game_archive_items(game_id,owner_id,archive_kind,item_id,sequence,revision) values(p_game,p_owner,'event',i->>'eventId',(i->>'sequence')::bigint,p_revision);
  end loop;
  for i in select value from jsonb_array_elements(p_batch->'chunks') loop
    insert into app_private.cloud_game_archive_items(game_id,owner_id,archive_kind,item_id,sequence,revision) values(p_game,p_owner,'chunk',i->>'chunkId',(i->>'sequence')::bigint,p_revision);
  end loop;
end;
$function$;

create function public.cloud_create_game(
  p_game_id uuid,p_schema_version integer,p_operation_id uuid,p_initial_checkpoint_dto text,p_initial_batch_base64 text,p_initial_batch_sha256_hex text
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare owner_id uuid:=auth.uid(); digest_value bytea; prior jsonb; checkpoint jsonb; batch jsonb; revision_value bigint; final_value jsonb; response_value jsonb; batch_bytes bytea;
begin
  if owner_id is null then raise exception 'authenticated owner required' using errcode='42501'; end if;
  if p_game_id is null or p_operation_id is null or p_schema_version is distinct from 1 then raise exception 'unsupported or invalid game creation request' using errcode='22023'; end if;
  digest_value:=app_private.request_digest(jsonb_build_object('ownerId',owner_id,'kind','create','gameId',p_game_id,'schemaVersion',p_schema_version,
    'checkpoint',p_initial_checkpoint_dto,'batchBase64',p_initial_batch_base64,'batchSha256',p_initial_batch_sha256_hex));
  perform app_private.lock_operation(owner_id,p_operation_id); perform app_private.lock_game(p_game_id);
  prior:=app_private.previous_response(owner_id,p_operation_id,digest_value); if prior is not null then return prior; end if;
  if exists(select 1 from app_private.cloud_game_tombstones where game_id=p_game_id) or exists(select 1 from app_private.cloud_games where game_id=p_game_id) then
    raise exception 'game identifier is unavailable' using errcode='23505';
  end if;
  checkpoint:=app_private.validate_game_checkpoint(p_initial_checkpoint_dto,p_game_id,owner_id,0);
  revision_value:=app_private.safe_integer(checkpoint->'revision','checkpoint.revision',1);
  batch:=app_private.validate_archive_batch(p_initial_batch_base64,p_initial_batch_sha256_hex,p_game_id,null,0,revision_value,null,null);
  batch_bytes:=decode(p_initial_batch_base64,'base64');
  if checkpoint#>>'{result,kind}'='final' then final_value:=checkpoint->'result'; end if;
  insert into app_private.cloud_games(game_id,owner_id,schema_version,final_result) values(p_game_id,owner_id,1,final_value);
  insert into app_private.cloud_game_ownership(game_id,owner_id,schema_version,ownership_epoch,accepted_revision,events_through_sequence,chunks_through_sequence)
  values(p_game_id,owner_id,1,1,revision_value,(batch->>'eventsThroughSequence')::bigint,(batch->>'chunksThroughSequence')::bigint);
  insert into app_private.cloud_game_checkpoints(game_id,owner_id,schema_version,revision,ownership_epoch,operation_id,checkpoint_json,payload_sha256)
  values(p_game_id,owner_id,1,revision_value,1,p_operation_id,p_initial_checkpoint_dto,extensions.digest(convert_to(p_initial_checkpoint_dto,'UTF8'),'sha256'));
  insert into app_private.cloud_game_archive_batches(game_id,owner_id,schema_version,revision,ownership_epoch,operation_id,
    events_after_sequence,events_through_sequence,chunks_after_sequence,chunks_through_sequence,batch_bytes,payload_sha256)
  values(p_game_id,owner_id,1,revision_value,1,p_operation_id,(batch->>'eventsAfterSequence')::bigint,(batch->>'eventsThroughSequence')::bigint,
    (batch->>'chunksAfterSequence')::bigint,(batch->>'chunksThroughSequence')::bigint,batch_bytes,extensions.digest(batch_bytes,'sha256'));
  perform app_private.insert_archive_items(p_game_id,owner_id,revision_value,batch);
  response_value:=jsonb_build_object('gameId',p_game_id,'schemaVersion',1,'revision',revision_value,'ownershipEpoch',1,'operationId',p_operation_id,'finalResult',final_value,'deleted',false);
  perform app_private.store_operation(owner_id,p_game_id,p_operation_id,'create',digest_value,response_value);
  return response_value;
exception when unique_violation then raise exception 'game identifier or operation ID is unavailable' using errcode='23505';
end;
$function$;

create function public.cloud_commit_game(
  p_game_id uuid,p_schema_version integer,p_expected_revision bigint,p_expected_epoch bigint,p_operation_id uuid,
  p_batch_base64 text,p_batch_sha256_hex text,p_checkpoint_dto text,p_final_result text default null
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare
  v_owner uuid:=auth.uid(); digest_value bytea; prior jsonb; checkpoint jsonb; batch jsonb; input_final jsonb; result_value jsonb;
  current_revision bigint; current_epoch bigint; v_current_schema integer; current_final jsonb; event_watermark bigint; chunk_watermark bigint;
  revision_value bigint; batch_bytes bytea; response_value jsonb;
begin
  if v_owner is null then raise exception 'authenticated owner required' using errcode='42501'; end if;
  if p_game_id is null or p_operation_id is null or p_schema_version is distinct from 1 or p_expected_revision is null or p_expected_revision<1 or p_expected_epoch is null or p_expected_epoch<1 then
    raise exception 'invalid game operation request' using errcode='22023';
  end if;
  digest_value:=app_private.request_digest(jsonb_build_object('ownerId',v_owner,'kind','commit','gameId',p_game_id,'schemaVersion',p_schema_version,
    'expectedRevision',p_expected_revision,'expectedEpoch',p_expected_epoch,'batchBase64',p_batch_base64,'batchSha256',p_batch_sha256_hex,
    'checkpoint',p_checkpoint_dto,'finalResult',p_final_result));
  perform app_private.lock_operation(v_owner,p_operation_id); perform app_private.lock_game(p_game_id);
  prior:=app_private.previous_response(v_owner,p_operation_id,digest_value); if prior is not null then return prior; end if;
  select game.schema_version,game.final_result,own.accepted_revision,own.ownership_epoch,own.events_through_sequence,own.chunks_through_sequence
  into v_current_schema,current_final,current_revision,current_epoch,event_watermark,chunk_watermark
  from app_private.cloud_games game join app_private.cloud_game_ownership own on own.game_id=game.game_id and own.owner_id=game.owner_id
  where game.game_id=p_game_id and game.owner_id=v_owner for update of game,own;
  if not found then
    if exists(select 1 from app_private.cloud_game_tombstones where game_id=p_game_id and owner_id=v_owner) then raise exception 'game has been deleted' using errcode='55000'; end if;
    raise exception 'game is unavailable to this user' using errcode='42501';
  end if;
  if v_current_schema<>p_schema_version then raise exception 'game schema version is incompatible' using errcode='55000'; end if;
  if p_expected_epoch<>current_epoch then raise exception 'ownership epoch is stale' using errcode='40001'; end if;
  if p_expected_revision<>current_revision then raise exception 'game revision is stale' using errcode='40001'; end if;
  checkpoint:=app_private.validate_game_checkpoint(p_checkpoint_dto,p_game_id,v_owner,current_epoch);
  revision_value:=app_private.safe_integer(checkpoint->'revision','checkpoint.revision',1);
  if revision_value<=p_expected_revision then raise exception 'checkpoint revision must advance beyond accepted revision' using errcode='22023'; end if;
  batch:=app_private.validate_archive_batch(p_batch_base64,p_batch_sha256_hex,p_game_id,p_expected_revision,p_expected_epoch,revision_value,event_watermark,chunk_watermark);
  batch_bytes:=decode(p_batch_base64,'base64'); result_value:=checkpoint->'result';
  if p_final_result is not null then
    begin perform app_private.assert_no_duplicate_json_keys(p_final_result::json); input_final:=p_final_result::jsonb;
    exception when others then raise exception 'final result is not valid JSON' using errcode='22023'; end;
    perform app_private.validate_result_json(input_final,'final result');
    if input_final->>'kind'<>'final' then raise exception 'final result must be final' using errcode='22023'; end if;
  end if;
  if current_final is not null then
    if result_value->>'kind'<>'final' or result_value is distinct from current_final then raise exception 'a final result cannot be changed' using errcode='55000'; end if;
    if input_final is not null and input_final is distinct from current_final then raise exception 'a final result cannot be changed' using errcode='55000'; end if;
  elsif result_value->>'kind'='final' then
    if input_final is null or input_final is distinct from result_value then raise exception 'final result must match the checkpoint result' using errcode='22023'; end if;
    current_final:=result_value;
  elsif input_final is not null then raise exception 'only a final checkpoint can latch a final result' using errcode='22023';
  end if;
  insert into app_private.cloud_game_checkpoints(game_id,owner_id,schema_version,revision,ownership_epoch,operation_id,checkpoint_json,payload_sha256)
  values(p_game_id,v_owner,1,revision_value,current_epoch,p_operation_id,p_checkpoint_dto,extensions.digest(convert_to(p_checkpoint_dto,'UTF8'),'sha256'));
  insert into app_private.cloud_game_archive_batches(game_id,owner_id,schema_version,revision,ownership_epoch,operation_id,
    events_after_sequence,events_through_sequence,chunks_after_sequence,chunks_through_sequence,batch_bytes,payload_sha256)
  values(p_game_id,v_owner,1,revision_value,current_epoch,p_operation_id,(batch->>'eventsAfterSequence')::bigint,(batch->>'eventsThroughSequence')::bigint,
    (batch->>'chunksAfterSequence')::bigint,(batch->>'chunksThroughSequence')::bigint,batch_bytes,extensions.digest(batch_bytes,'sha256'));
  perform app_private.insert_archive_items(p_game_id,v_owner,revision_value,batch);
  update app_private.cloud_game_ownership own set accepted_revision=revision_value,events_through_sequence=(batch->>'eventsThroughSequence')::bigint,
    chunks_through_sequence=(batch->>'chunksThroughSequence')::bigint,updated_at=clock_timestamp() where own.game_id=p_game_id and own.owner_id=v_owner;
  update app_private.cloud_games game set final_result=current_final,updated_at=clock_timestamp() where game.game_id=p_game_id and game.owner_id=v_owner;
  response_value:=jsonb_build_object('gameId',p_game_id,'schemaVersion',1,'revision',revision_value,'ownershipEpoch',current_epoch,
    'operationId',p_operation_id,'finalResult',current_final,'deleted',false);
  perform app_private.store_operation(v_owner,p_game_id,p_operation_id,'commit',digest_value,response_value);
  return response_value;
end;
$function$;

create function public.cloud_takeover_game(p_game_id uuid,p_schema_version integer,p_acknowledged_revision bigint,p_expected_epoch bigint,p_operation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare v_owner uuid:=auth.uid(); v_digest bytea; v_prior jsonb; v_revision bigint; v_epoch bigint; v_schema integer; v_final jsonb; v_next bigint; v_response jsonb;
begin
  if v_owner is null then raise exception 'authenticated owner required' using errcode='42501'; end if;
  if p_game_id is null or p_operation_id is null or p_schema_version is distinct from 1 or p_acknowledged_revision is null or p_acknowledged_revision<1 or p_expected_epoch is null or p_expected_epoch<1 then raise exception 'invalid takeover request' using errcode='22023'; end if;
  v_digest:=app_private.request_digest(jsonb_build_object('ownerId',v_owner,'kind','takeover','gameId',p_game_id,'schemaVersion',p_schema_version,'acknowledgedRevision',p_acknowledged_revision,'expectedEpoch',p_expected_epoch));
  perform app_private.lock_operation(v_owner,p_operation_id); perform app_private.lock_game(p_game_id);
  v_prior:=app_private.previous_response(v_owner,p_operation_id,v_digest); if v_prior is not null then return v_prior; end if;
  select game.schema_version,game.final_result,own.accepted_revision,own.ownership_epoch into v_schema,v_final,v_revision,v_epoch
  from app_private.cloud_games game join app_private.cloud_game_ownership own on own.game_id=game.game_id and own.owner_id=game.owner_id
  where game.game_id=p_game_id and game.owner_id=v_owner for update of game,own;
  if not found then
    if exists(select 1 from app_private.cloud_game_tombstones where game_id=p_game_id and owner_id=v_owner) then raise exception 'game has been deleted' using errcode='55000'; end if;
    raise exception 'game is unavailable to this user' using errcode='42501';
  end if;
  if v_schema<>p_schema_version then raise exception 'game schema version is incompatible' using errcode='55000'; end if;
  if p_expected_epoch<>v_epoch then raise exception 'ownership epoch is stale' using errcode='40001'; end if;
  if p_acknowledged_revision<>v_revision then raise exception 'acknowledged revision is stale' using errcode='40001'; end if;
  if not exists(select 1 from app_private.cloud_game_checkpoints where game_id=p_game_id and owner_id=v_owner and revision=v_revision) then raise exception 'takeover requires the latest persisted checkpoint' using errcode='55000'; end if;
  if v_epoch>=9007199254740991 then raise exception 'ownership epoch is exhausted' using errcode='22003'; end if;
  v_next:=v_epoch+1; update app_private.cloud_game_ownership set ownership_epoch=v_next,updated_at=clock_timestamp() where game_id=p_game_id and owner_id=v_owner;
  v_response:=jsonb_build_object('gameId',p_game_id,'schemaVersion',1,'revision',v_revision,'ownershipEpoch',v_next,'operationId',p_operation_id,'finalResult',v_final,'deleted',false);
  perform app_private.store_operation(v_owner,p_game_id,p_operation_id,'takeover',v_digest,v_response); return v_response;
end;
$function$;

create function public.cloud_delete_game(p_game_id uuid,p_schema_version integer,p_expected_revision bigint,p_expected_epoch bigint,p_operation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare v_owner uuid:=auth.uid(); v_digest bytea; v_prior jsonb; v_revision bigint; v_epoch bigint; v_schema integer; v_deleted_revision bigint; v_deleted_epoch bigint; v_response jsonb;
begin
  if v_owner is null then raise exception 'authenticated owner required' using errcode='42501'; end if;
  if p_game_id is null or p_operation_id is null or p_schema_version is distinct from 1 or p_expected_revision is null or p_expected_revision<1 or p_expected_epoch is null or p_expected_epoch<1 then raise exception 'invalid deletion request' using errcode='22023'; end if;
  v_digest:=app_private.request_digest(jsonb_build_object('ownerId',v_owner,'kind','delete','gameId',p_game_id,'schemaVersion',p_schema_version,'expectedRevision',p_expected_revision,'expectedEpoch',p_expected_epoch));
  perform app_private.lock_operation(v_owner,p_operation_id); perform app_private.lock_game(p_game_id);
  v_prior:=app_private.previous_response(v_owner,p_operation_id,v_digest); if v_prior is not null then return v_prior; end if;
  if exists(select 1 from app_private.cloud_game_tombstones where game_id=p_game_id and owner_id=v_owner) then raise exception 'game has been deleted' using errcode='55000'; end if;
  select game.schema_version,own.accepted_revision,own.ownership_epoch into v_schema,v_revision,v_epoch
  from app_private.cloud_games game join app_private.cloud_game_ownership own on own.game_id=game.game_id and own.owner_id=game.owner_id
  where game.game_id=p_game_id and game.owner_id=v_owner for update of game,own;
  if not found then raise exception 'game is unavailable to this user' using errcode='42501'; end if;
  if v_schema<>p_schema_version then raise exception 'game schema version is incompatible' using errcode='55000'; end if;
  if p_expected_epoch<>v_epoch then raise exception 'ownership epoch is stale' using errcode='40001'; end if;
  if p_expected_revision<>v_revision then raise exception 'game revision is stale' using errcode='40001'; end if;
  if v_revision>=9007199254740991 or v_epoch>=9007199254740991 then raise exception 'deletion counter is exhausted' using errcode='22003'; end if;
  v_deleted_revision:=v_revision+1; v_deleted_epoch:=v_epoch+1;
  insert into app_private.cloud_game_tombstones(game_id,owner_id,schema_version,deleted_revision,deleted_epoch,deletion_operation_id)
  values(p_game_id,v_owner,1,v_deleted_revision,v_deleted_epoch,p_operation_id);
  delete from app_private.cloud_game_archive_items where game_id=p_game_id and owner_id=v_owner;
  delete from app_private.cloud_game_archive_batches where game_id=p_game_id and owner_id=v_owner;
  delete from app_private.cloud_game_checkpoints where game_id=p_game_id and owner_id=v_owner;
  delete from app_private.cloud_game_ownership where game_id=p_game_id and owner_id=v_owner;
  delete from app_private.cloud_games where game_id=p_game_id and owner_id=v_owner;
  update app_private.cloud_game_outbox operation set response=jsonb_build_object('gameId',operation.game_id,'schemaVersion',operation.schema_version,
    'revision',operation.response->'revision','ownershipEpoch',operation.response->'ownershipEpoch','operationId',operation.operation_id,
    'operationKind',operation.operation_kind,'deleted',true,'receiptOnly',true)
  where operation.owner_id=v_owner and operation.game_id=p_game_id;
  v_response:=jsonb_build_object('gameId',p_game_id,'schemaVersion',1,'revision',v_deleted_revision,'ownershipEpoch',v_deleted_epoch,
    'operationId',p_operation_id,'operationKind','delete','deleted',true,'receiptOnly',true);
  perform app_private.store_operation(v_owner,p_game_id,p_operation_id,'delete',v_digest,v_response); return v_response;
end;
$function$;

create function public.cloud_read_operation(p_game_id uuid,p_operation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare v_owner uuid:=auth.uid(); v_response jsonb; v_kind text; v_digest bytea; v_deleted boolean;
begin
  if v_owner is null then raise exception 'authenticated owner required' using errcode='42501'; end if;
  if p_game_id is null or p_operation_id is null then raise exception 'game and operation IDs are required' using errcode='22023'; end if;
  perform app_private.lock_operation(v_owner,p_operation_id); perform app_private.lock_game_shared(p_game_id);
  select response,operation_kind,request_digest into v_response,v_kind,v_digest from app_private.cloud_game_outbox
  where owner_id=v_owner and game_id=p_game_id and operation_id=p_operation_id for share;
  if not found then
    if not exists(select 1 from app_private.cloud_games where game_id=p_game_id and owner_id=v_owner)
      and not exists(select 1 from app_private.cloud_game_tombstones where game_id=p_game_id and owner_id=v_owner) then raise exception 'game is unavailable to this user' using errcode='42501'; end if;
    return jsonb_build_object('gameId',p_game_id,'operationId',p_operation_id,'found',false);
  end if;
  if exists(select 1 from app_private.cloud_game_tombstones where game_id=p_game_id and owner_id=v_owner) then
    v_response:=jsonb_build_object('gameId',p_game_id,'schemaVersion',1,'revision',v_response->'revision','ownershipEpoch',v_response->'ownershipEpoch',
      'operationId',p_operation_id,'operationKind',v_kind,'deleted',true,'receiptOnly',true);
  end if;
  return jsonb_build_object('gameId',p_game_id,'operationId',p_operation_id,'found',true,'operationKind',v_kind,
    'requestDigest',encode(v_digest,'hex'),'response',v_response);
end;
$function$;

create function public.cloud_read_game(
  p_game_id uuid,p_after_revision bigint default 0,p_include_checkpoint boolean default true,p_page_limit integer default 20,
  p_through_revision bigint default null,p_target_epoch bigint default null,p_target_checkpoint_sha256 text default null
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,app_private,auth,extensions,pg_temp set row_security=on as $function$
declare
  v_owner uuid:=auth.uid(); v_schema integer; v_revision bigint; v_epoch bigint;
  target_revision bigint; target_epoch bigint; target_sha text; checkpoint_row app_private.cloud_game_checkpoints%rowtype;
  batches jsonb; last_revision bigint; last_events bigint; last_chunks bigint; more_rows boolean;
  tomb app_private.cloud_game_tombstones%rowtype; target_final jsonb;
begin
  if v_owner is null then raise exception 'authenticated owner required' using errcode='42501'; end if;
  if p_game_id is null or p_after_revision is null or p_after_revision<0 or p_page_limit is null or p_page_limit<1 or p_page_limit>100 then raise exception 'invalid read cursor' using errcode='22023'; end if;
  if (p_through_revision is null)<>(p_target_epoch is null) or (p_through_revision is null)<>(p_target_checkpoint_sha256 is null) then raise exception 'frozen target fields must be supplied together' using errcode='22023'; end if;
  perform app_private.lock_game_shared(p_game_id);
  select game.schema_version,own.accepted_revision,own.ownership_epoch into v_schema,v_revision,v_epoch
  from app_private.cloud_games game join app_private.cloud_game_ownership own on own.game_id=game.game_id and own.owner_id=game.owner_id
  where game.game_id=p_game_id and game.owner_id=v_owner for share of game,own;
  if not found then
    select * into tomb from app_private.cloud_game_tombstones where game_id=p_game_id and owner_id=v_owner for share;
    if not found then raise exception 'game is unavailable to this user' using errcode='42501'; end if;
    return jsonb_build_object('gameId',p_game_id,'schemaVersion',1,'deleted',true,'revision',tomb.deleted_revision,'ownershipEpoch',tomb.deleted_epoch,
      'operationId',tomb.deletion_operation_id,'operationKind','delete','receiptOnly',true,
      'deletedAt',tomb.deleted_at,'checkpoint',null,'archiveBatches','[]'::jsonb,'hasMore',false);
  end if;
  if p_through_revision is null then
    target_revision:=v_revision; target_epoch:=v_epoch;
    select * into checkpoint_row from app_private.cloud_game_checkpoints where game_id=p_game_id and owner_id=v_owner and revision=target_revision;
    if not found then raise exception 'latest checkpoint is unavailable' using errcode='55000'; end if;
  else
    if p_through_revision<1 or p_target_epoch<1 or p_target_checkpoint_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'frozen read target is invalid' using errcode='22023'; end if;
    if p_target_epoch<>v_epoch or p_through_revision>v_revision then raise exception 'frozen read target is no longer available' using errcode='40001'; end if;
    target_revision:=p_through_revision; target_epoch:=p_target_epoch;
    select * into checkpoint_row from app_private.cloud_game_checkpoints where game_id=p_game_id and owner_id=v_owner and revision=target_revision;
    if not found or encode(checkpoint_row.payload_sha256,'hex')<>p_target_checkpoint_sha256 then raise exception 'frozen checkpoint target is no longer available' using errcode='40001'; end if;
  end if;
  target_sha:=encode(checkpoint_row.payload_sha256,'hex');
  if p_after_revision>target_revision then raise exception 'read cursor is beyond its target' using errcode='22023'; end if;
  if p_after_revision>0 and not exists(select 1 from app_private.cloud_game_archive_batches where game_id=p_game_id and owner_id=v_owner and revision=p_after_revision) then
    raise exception 'archive cursor revision is unavailable' using errcode='40001';
  end if;
  last_revision:=p_after_revision;
  select coalesce(jsonb_agg(jsonb_build_object('revision',page.revision,'ownershipEpoch',page.ownership_epoch,'operationId',page.operation_id,
      'eventsAfterSequence',page.events_after_sequence,'eventsThroughSequence',page.events_through_sequence,
      'chunksAfterSequence',page.chunks_after_sequence,'chunksThroughSequence',page.chunks_through_sequence,
      'batchBase64',translate(encode(page.batch_bytes,'base64'),E'\n\r',''),'sha256',encode(page.payload_sha256,'hex'),'createdAt',page.created_at) order by page.revision),'[]'::jsonb),
      max(page.revision),(array_agg(page.events_through_sequence order by page.revision desc))[1],(array_agg(page.chunks_through_sequence order by page.revision desc))[1]
  into batches,last_revision,last_events,last_chunks
  from (select * from app_private.cloud_game_archive_batches where game_id=p_game_id and owner_id=v_owner and revision>p_after_revision and revision<=target_revision order by revision limit p_page_limit) page;
  if last_revision is null then
    last_revision:=p_after_revision;
    if p_after_revision>0 then select events_through_sequence,chunks_through_sequence into last_events,last_chunks from app_private.cloud_game_archive_batches where game_id=p_game_id and owner_id=v_owner and revision=p_after_revision; end if;
  end if;
  select exists(select 1 from app_private.cloud_game_archive_batches where game_id=p_game_id and owner_id=v_owner and revision>last_revision and revision<=target_revision) into more_rows;
  if checkpoint_row.checkpoint_json::jsonb#>>'{result,kind}'='final' then target_final:=checkpoint_row.checkpoint_json::jsonb->'result'; end if;
  return jsonb_build_object('gameId',p_game_id,'schemaVersion',v_schema,'acceptedRevision',v_revision,'ownershipEpoch',v_epoch,'finalResult',target_final,'deleted',false,
    'throughRevision',target_revision,'targetEpoch',target_epoch,'targetCheckpointSha256',target_sha,
    'checkpoint',case when p_include_checkpoint then jsonb_build_object('revision',checkpoint_row.revision,'ownershipEpoch',checkpoint_row.ownership_epoch,
      'operationId',checkpoint_row.operation_id,'payload',checkpoint_row.checkpoint_json,'sha256',target_sha,'createdAt',checkpoint_row.created_at) else null::jsonb end,
    'archiveBatches',batches,'hasMore',more_rows,
    'nextCursor',jsonb_build_object('afterRevision',last_revision,'afterEventSequence',last_events,'afterChunkSequence',last_chunks,
      'throughRevision',target_revision,'targetEpoch',target_epoch,'targetCheckpointSha256',target_sha));
end;
$function$;

revoke all on all functions in schema app_private from public,anon,authenticated,service_role;
alter default privileges in schema app_private revoke execute on functions from public,anon,authenticated,service_role;
revoke all on function public.cloud_create_game(uuid,integer,uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.cloud_commit_game(uuid,integer,bigint,bigint,uuid,text,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.cloud_takeover_game(uuid,integer,bigint,bigint,uuid) from public,anon,authenticated,service_role;
revoke all on function public.cloud_delete_game(uuid,integer,bigint,bigint,uuid) from public,anon,authenticated,service_role;
revoke all on function public.cloud_read_operation(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.cloud_read_game(uuid,bigint,boolean,integer,bigint,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.cloud_create_game(uuid,integer,uuid,text,text,text) to authenticated;
grant execute on function public.cloud_commit_game(uuid,integer,bigint,bigint,uuid,text,text,text,text) to authenticated;
grant execute on function public.cloud_takeover_game(uuid,integer,bigint,bigint,uuid) to authenticated;
grant execute on function public.cloud_delete_game(uuid,integer,bigint,bigint,uuid) to authenticated;
grant execute on function public.cloud_read_operation(uuid,uuid) to authenticated;
grant execute on function public.cloud_read_game(uuid,bigint,boolean,integer,bigint,bigint,text) to authenticated;
comment on function public.cloud_create_game(uuid,integer,uuid,text,text,text) is 'Creates sparse local checkpoint revision N at cloud epoch 1, preserving submitted checkpoint epoch 0 and initial archive bytes.';
comment on function public.cloud_commit_game(uuid,integer,bigint,bigint,uuid,text,text,text,text) is 'Checks operation identity, owner, epoch before revision, sparse checkpoint advance, archive digests, and immutable semantic final result.';
comment on function public.cloud_takeover_game(uuid,integer,bigint,bigint,uuid) is 'Advances only the cloud ownership epoch at the latest accepted local revision.';
comment on function public.cloud_delete_game(uuid,integer,bigint,bigint,uuid) is 'Writes a permanent tombstone, removes checkpoint and archive payload, and replaces operation responses with payload-free receipts.';
comment on function public.cloud_read_operation(uuid,uuid) is 'Returns one owner-scoped idempotency response or deletion receipt under the operation lock.';
comment on function public.cloud_read_game(uuid,bigint,boolean,integer,bigint,bigint,text) is 'Returns a frozen target checkpoint and bounded exact archive batch pages for the authenticated owner.';

commit;
