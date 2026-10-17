begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

insert into auth.users (id,aud,role,email) values
 ('11111111-1111-4111-8111-111111111111','authenticated','authenticated','kha41-owner@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','authenticated','authenticated','kha41-other@example.invalid');

create function pg_temp.kha41_checkpoint(
  p_game uuid,p_revision bigint,p_epoch bigint,p_result jsonb default '{"kind":"unresolved"}'::jsonb,
  p_version integer default 1,p_namespace_kind text default 'account',p_account_id uuid default auth.uid(),
  p_practice_mode text default 'ordinary',p_practice_original_result jsonb default null
) returns text language sql as $function$
  select jsonb_build_object(
    'schemaVersion',p_version,'gameId',p_game::text,'namespace',case when p_namespace_kind='guest' then jsonb_build_object('kind','guest') else jsonb_build_object('kind',p_namespace_kind,'accountId',p_account_id::text) end,
    'revision',p_revision,'ownershipEpoch',p_epoch,'segmentId','segment-id:α','positionRevision',7,'requestGeneration',11,'analysisGeneration',13,'updatedAtMs',1790000000123,
    'rules',jsonb_build_object('variant','orthodox','startingFen','start fen','currentFen','current fen','sideToMove','white','castlingRights','KQkq',
      'enPassantSquare',null,'halfmoveClock','0','fullmoveNumber','1','repetitionLedger',jsonb_build_object('version',1,'positions',jsonb_build_array(jsonb_build_object('identity','position-key','occurrences','1'))),'moves','[]'::jsonb),
    'history',jsonb_build_object('currentSegmentId','segment-id:α','segments',jsonb_build_array(jsonb_build_object('segmentId','segment-id:α','providerId','provider:raw','modelRoutingId','model:raw','connectionRevision',2,'startedAtMs',1780000000000,'messageIds','[]'::jsonb)),'messages','[]'::jsonb),
    'clocks',jsonb_build_object('schemaVersion',1,'timeControl',jsonb_build_object('startingTimeMs',60000,'incrementMs',1000),
      'banksAtAnchor',jsonb_build_object('whiteMs',59000,'blackMs',60000),'activeSide','white',
      'anchor',jsonb_build_object('monotonicMs',100.5,'wallTimeMs',1790000000001,'hostOffsetMs',12.25),'lastReconciledAtMs',1790000000002),
    'budgets',jsonb_build_object('formattingCorrectionsRemaining',3,'illegalMoveAttemptsRemaining',jsonb_build_object('white',4,'black',5),'manualRetriesBySide',jsonb_build_object('white',6,'black',7)),
    'selections',jsonb_build_object('players',jsonb_build_object('white',jsonb_build_object('kind','human'),
      'black',jsonb_build_object('kind','model','providerId','provider-id','connectionId','connection-id','configurationRevision',3,'modelRoutingId','route-id','protocol','custom','diagnostic','unknown'))),
    'archive',jsonb_build_object('egressStatus','eligible','currentLine',jsonb_build_object('lineId','line-id:current','eventIds','[]'::jsonb),'discardedLines','[]'::jsonb),
    'result',p_result,'practice',jsonb_build_object('mode',p_practice_mode,'scored',false,'sourceGameId',null,'sourcePositionFen',null,'originalResult',p_practice_original_result),'extensions','{}'::jsonb
  )::text;
$function$;

create function pg_temp.kha41_event(p_game uuid,p_id text,p_seq bigint,p_kind text,p_state text,p_payload jsonb,p_chunk_ids text[] default '{}'::text[])
returns jsonb language sql as $function$
  select jsonb_build_object('eventId',p_id,'gameId',p_game::text,'sequence',p_seq,'segmentId','segment-id:α','kind',p_kind,
    'occurredAtMs',1790000000100+p_seq,'receiveState',p_state,'egressStatus','eligible','payload',p_payload,'chunkIds',to_jsonb(p_chunk_ids));
$function$;

create function pg_temp.kha41_chunk(p_game uuid,p_id text,p_seq bigint,p_bytes text,p_final boolean default false)
returns jsonb language sql as $function$
  select jsonb_build_object('chunkId',p_id,'gameId',p_game::text,'sequence',p_seq,'receivedAtMs',1790000000200+p_seq,
    'isFinal',p_final,'egressStatus','eligible','bytesBase64',encode(convert_to(p_bytes,'UTF8'),'base64'),
    'sha256',encode(extensions.digest(convert_to(p_bytes,'UTF8'),'sha256'),'hex'));
$function$;

create function pg_temp.kha41_batch(p_game uuid,p_base_revision bigint,p_base_epoch bigint,p_checkpoint_revision bigint,
  p_events_after bigint,p_events_through bigint,p_chunks_after bigint,p_chunks_through bigint,p_events jsonb default '[]'::jsonb,p_chunks jsonb default '[]'::jsonb)
returns jsonb language sql as $function$
  select jsonb_build_object('format','kamkmchess.cloud-archive-batch','schemaVersion',1,'gameId',p_game::text,
    'baseRevision',p_base_revision,'baseOwnershipEpoch',p_base_epoch,'checkpointRevision',p_checkpoint_revision,
    'eventsAfterSequence',p_events_after,'eventsThroughSequence',p_events_through,'chunksAfterSequence',p_chunks_after,'chunksThroughSequence',p_chunks_through,
    'events',p_events,'chunks',p_chunks);
$function$;
create function pg_temp.kha41_b64(p_batch jsonb) returns text language sql as $function$
  select translate(encode(convert_to(p_batch::text,'UTF8'),'base64'),E'\n\r','');
$function$;
create function pg_temp.kha41_sha(p_batch jsonb) returns text language sql as $function$
  select encode(extensions.digest(convert_to(p_batch::text,'UTF8'),'sha256'),'hex');
$function$;

set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);

-- DAT-04 and OPS-01: every private relation and callable path remains owner-only.
-- Catalog metadata is inspected as postgres; the target roles remain explicit below.
reset role;
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='app_private.cloud_games'::regclass),'game metadata forces RLS');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='app_private.cloud_game_ownership'::regclass),'ownership metadata forces RLS');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='app_private.cloud_game_checkpoints'::regclass),'checkpoint rows force RLS');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='app_private.cloud_game_archive_batches'::regclass),'archive batch rows force RLS');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='app_private.cloud_game_archive_items'::regclass),'archive identity rows force RLS');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='app_private.cloud_game_outbox'::regclass),'operation rows force RLS');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='app_private.cloud_game_tombstones'::regclass),'tombstone rows force RLS');
select is((select count(*) from pg_policies where schemaname='app_private' and policyname='owner_access'),7::bigint,'each private table has an owner policy');
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='app_private' or (n.nspname='public' and left(p.proname,6)='cloud_')) and p.prosecdef
  and not coalesce(p.proconfig @> array['search_path=pg_catalog, app_private, auth, extensions, pg_temp','row_security=on'],false)),
  'every security-definer function pins search_path and enables row security');
select ok(not exists(select 1 from (values
  ('app_private.cloud_games'),('app_private.cloud_game_ownership'),('app_private.cloud_game_checkpoints'),('app_private.cloud_game_archive_batches'),
  ('app_private.cloud_game_archive_items'),('app_private.cloud_game_outbox'),('app_private.cloud_game_tombstones')) t(name)
  cross join (values('anon'),('authenticated'),('service_role')) r(name)
  where has_table_privilege(r.name,t.name,'SELECT') or has_table_privilege(r.name,t.name,'INSERT')
    or has_table_privilege(r.name,t.name,'UPDATE') or has_table_privilege(r.name,t.name,'DELETE')),
  'browser roles and service_role have no direct table privileges');
select ok((select bool_and(has_function_privilege('authenticated',signature,'EXECUTE')) from (values
  ('public.cloud_create_game(uuid,integer,uuid,text,text,text)'),
  ('public.cloud_commit_game(uuid,integer,bigint,bigint,uuid,text,text,text,text)'),
  ('public.cloud_takeover_game(uuid,integer,bigint,bigint,uuid)'),
  ('public.cloud_delete_game(uuid,integer,bigint,bigint,uuid)'),
  ('public.cloud_read_operation(uuid,uuid)'),
  ('public.cloud_read_game(uuid,bigint,boolean,integer,bigint,bigint,text)')) f(signature)
  ) and not exists(select 1 from (values('anon'),('service_role')) r(name) cross join (values
  ('public.cloud_create_game(uuid,integer,uuid,text,text,text)'),
  ('public.cloud_commit_game(uuid,integer,bigint,bigint,uuid,text,text,text,text)'),
  ('public.cloud_takeover_game(uuid,integer,bigint,bigint,uuid)'),
  ('public.cloud_delete_game(uuid,integer,bigint,bigint,uuid)'),
  ('public.cloud_read_operation(uuid,uuid)'),
  ('public.cloud_read_game(uuid,bigint,boolean,integer,bigint,bigint,text)')) f(signature)
  where has_function_privilege(r.name,f.signature,'EXECUTE')),
  'only authenticated sessions can call the six storage RPCs');

set local role authenticated;
select throws_ok($$insert into app_private.cloud_games(game_id,owner_id,schema_version) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',auth.uid(),1) on conflict(game_id) do update set schema_version=excluded.schema_version$$,
  '42501',null,'owner cannot bypass RPC CAS with direct insert or upsert');

select throws_ok($$select public.cloud_create_game('99999999-9999-4999-8999-999999999999',1,'99999999-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('99999999-9999-4999-8999-999999999999',3,0,'{"kind":"final","winner":"white","reason":"stalemate","eventId":"invalid:white","decidedAtMs":1790000000000}'::jsonb),
  pg_temp.kha41_b64(pg_temp.kha41_batch('99999999-9999-4999-8999-999999999999',null,0,3,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('99999999-9999-4999-8999-999999999999',null,0,3,null,null,null,null)))$$,
  '22023',null,'main white stalemate result is rejected before create writes');
select throws_ok($$select public.cloud_create_game('99999999-9999-4999-8999-999999999999',1,'99999999-0000-4000-8000-000000000002',
  pg_temp.kha41_checkpoint('99999999-9999-4999-8999-999999999999',3,0,'{"kind":"final","winner":"black","reason":"stalemate","eventId":"invalid:black","decidedAtMs":1790000000000}'::jsonb),
  pg_temp.kha41_b64(pg_temp.kha41_batch('99999999-9999-4999-8999-999999999999',null,0,3,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('99999999-9999-4999-8999-999999999999',null,0,3,null,null,null,null)))$$,
  '22023',null,'main black stalemate result is rejected before create writes');
select throws_ok($$select public.cloud_create_game('99999999-9999-4999-8999-999999999999',1,'99999999-0000-4000-8000-000000000003',
  pg_temp.kha41_checkpoint('99999999-9999-4999-8999-999999999999',3,0,p_practice_mode=>'practice',
    p_practice_original_result=>'{"kind":"final","winner":"white","reason":"stalemate","eventId":"invalid:practice:white","decidedAtMs":1790000000000}'::jsonb),
  pg_temp.kha41_b64(pg_temp.kha41_batch('99999999-9999-4999-8999-999999999999',null,0,3,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('99999999-9999-4999-8999-999999999999',null,0,3,null,null,null,null)))$$,
  '22023',null,'practice original white stalemate result is rejected before create writes');
select throws_ok($$select public.cloud_create_game('99999999-9999-4999-8999-999999999999',1,'99999999-0000-4000-8000-000000000004',
  pg_temp.kha41_checkpoint('99999999-9999-4999-8999-999999999999',3,0,p_practice_mode=>'practice',
    p_practice_original_result=>'{"kind":"final","winner":"black","reason":"stalemate","eventId":"invalid:practice:black","decidedAtMs":1790000000000}'::jsonb),
  pg_temp.kha41_b64(pg_temp.kha41_batch('99999999-9999-4999-8999-999999999999',null,0,3,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('99999999-9999-4999-8999-999999999999',null,0,3,null,null,null,null)))$$,
  '22023',null,'practice original black stalemate result is rejected before create writes');
select throws_ok($$select public.cloud_read_game('99999999-9999-4999-8999-999999999999')$$,
  '42501','game is unavailable to this user','invalid stalemate creates leave no game row');
select throws_ok($$select public.cloud_read_operation('99999999-9999-4999-8999-999999999999','99999999-0000-4000-8000-000000000001')$$,
  '42501','game is unavailable to this user','invalid main-result create leaves no operation record');
select throws_ok($$select public.cloud_read_operation('99999999-9999-4999-8999-999999999999','99999999-0000-4000-8000-000000000002')$$,
  '42501','game is unavailable to this user','invalid main-result create leaves no operation record');
select throws_ok($$select public.cloud_read_operation('99999999-9999-4999-8999-999999999999','99999999-0000-4000-8000-000000000003')$$,
  '42501','game is unavailable to this user','invalid practice-result create leaves no operation record');
select throws_ok($$select public.cloud_read_operation('99999999-9999-4999-8999-999999999999','99999999-0000-4000-8000-000000000004')$$,
  '42501','game is unavailable to this user','invalid practice-result create leaves no operation record');
select is(public.cloud_create_game('88888888-8888-4888-8888-888888888888',1,'88888888-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('88888888-8888-4888-8888-888888888888',4,0,p_practice_mode=>'practice',
    p_practice_original_result=>'{"kind":"final","winner":"draw","reason":"stalemate","eventId":"original:draw","decidedAtMs":1790000000000}'::jsonb),
  pg_temp.kha41_b64(pg_temp.kha41_batch('88888888-8888-4888-8888-888888888888',null,0,4,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('88888888-8888-4888-8888-888888888888',null,0,4,null,null,null,null)))->>'revision','4',
  'valid practice original draw stalemate is accepted');
select is((public.cloud_read_game('88888888-8888-4888-8888-888888888888')->'checkpoint'->>'payload')::jsonb->'practice'->'originalResult',
  '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"original:draw","decidedAtMs":1790000000000}'::jsonb,
  'valid practice original draw result is preserved');

-- First cloud claim preserves local revision 31 and checkpoint epoch 0.
select is(public.cloud_create_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'aaaaaaaa-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,0),
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,0,31,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,0,31,null,null,null,null)))->>'revision','31',
  'first upload stores the real sparse local revision 31');
select throws_ok($$update app_private.cloud_game_ownership set accepted_revision=999 where game_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  '42501',null,'owner cannot update accepted revision outside the CAS RPC');
select throws_ok($$insert into app_private.cloud_game_ownership(game_id,owner_id,schema_version,ownership_epoch,accepted_revision)
  values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',auth.uid(),1,99,999)
  on conflict(game_id) do update set ownership_epoch=excluded.ownership_epoch,accepted_revision=excluded.accepted_revision$$,
  '42501',null,'owner cannot use direct upsert to bypass revision and epoch CAS');
select throws_ok($$insert into app_private.cloud_game_archive_items(game_id,owner_id,archive_kind,item_id,sequence,revision)
  values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',auth.uid(),'event','event:forged',100,999)$$,
  '42501',null,'owner cannot insert archive identity metadata outside the batch RPC');
select is(public.cloud_create_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'aaaaaaaa-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,0),
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,0,31,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,0,31,null,null,null,null)))->>'ownershipEpoch','1',
  'same create operation returns its stored owner epoch');
select is(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'checkpoint'->>'payload',
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,0),'create preserves exact full checkpoint text and epoch zero');
select is((public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'checkpoint'->>'ownershipEpoch'),'1','checkpoint row records server epoch one separately');
select is(jsonb_array_length(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'archiveBatches'),1,'create stores its empty initial batch atomically');
select is(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'archiveBatches'->0->>'batchBase64',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,0,31,null,null,null,null)),
  'read returns the exact digest-bound initial batch bytes');

-- Offline local checkpoints coalesce from 31 to 61, then sparse revisions 70 and 74.
select is(public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,31,1,'aaaaaaaa-0000-4000-8000-000000000002',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,1,61,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,1,61,null,null,null,null)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',61,1))->>'revision','61','commit accepts coalesced local revision 61');
select is(public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,61,1,'aaaaaaaa-0000-4000-8000-000000000003',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',61,1,70,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',61,1,70,null,null,null,null)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',70,1))->>'revision','70','a second sparse local revision is accepted');
select is(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,true,1)->>'throughRevision','70','first bounded page freezes the target revision');
select is(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,true,1)->'archiveBatches'->0->>'revision','31','first page includes the bootstrap batch only');
select ok((public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,true,1)->>'hasMore')::boolean,'bounded read reports another page');
select is(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,true,1)->>'targetCheckpointSha256',
  encode(extensions.digest(convert_to(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',70,1),'UTF8'),'sha256'),'hex'),
  'first page returns the digest of its exact frozen checkpoint');
select throws_ok($$select public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,false,1,70,1,null)$$,
  '22023','frozen target fields must be supplied together','a later page cannot omit part of its frozen target');
select throws_ok($$select public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,false,1,70,1,repeat('0',64))$$,
  '40001','frozen checkpoint target is no longer available','a mismatched checkpoint digest forces a detectable restart');
select is(public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,70,1,'aaaaaaaa-0000-4000-8000-000000000004',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',70,1,74,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',70,1,74,null,null,null,null)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',74,1))->>'revision','74','cloud can advance while a reader keeps its earlier target');
select is(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,false,1,70,1,
  encode(extensions.digest(convert_to(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',70,1),'UTF8'),'sha256'),'hex'))->'archiveBatches'->0->>'revision',
  '61','later page remains inside frozen revision 70 after cloud advances to 74');
select is(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',61,false,1,70,1,
  encode(extensions.digest(convert_to(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',70,1),'UTF8'),'sha256'),'hex'))->'archiveBatches'->0->>'revision',
  '70','frozen final page includes revision 70 and excludes later revision 74');
select ok(not (public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',61,false,1,70,1,
  encode(extensions.digest(convert_to(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',70,1),'UTF8'),'sha256'),'hex'))->>'hasMore')::boolean,
  'bounded archive page ends at its frozen target');

-- A takeover between pages invalidates the old frozen epoch before its revision is used.
select is(public.cloud_takeover_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,74,1,'aaaaaaaa-0000-4000-8000-000000000005')->>'ownershipEpoch','2','takeover increments the cloud fence only');
select throws_ok($$select public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',70,false,1,70,1,encode(extensions.digest(convert_to(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',70,1),'UTF8'),'sha256'),'hex'))$$,
  '40001',null,'old frozen page reports a detectable restart after takeover');
select is(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'checkpoint'->>'payload',
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',74,1),'takeover did not rewrite the accepted checkpoint');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,100,1,'aaaaaaaa-0000-4000-8000-000000000006',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,1,101,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,1,101,null,null,null,null)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',101,1))$$,
  '40001',null,'stale epoch fails even when the caller claims a higher revision');
select is(public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,74,2,'aaaaaaaa-0000-4000-8000-000000000007',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',74,2,90,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',74,2,90,null,null,null,null)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',90,2))->>'revision','90','fresh epoch accepts sparse high-water after takeover');

-- Sequence zero, arbitrary archive fields, partial events, and unknown event kinds survive exact batch storage.
select is(public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,90,2,'aaaaaaaa-0000-4000-8000-000000000008',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',90,2,95,null,0,null,0,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:α',0,'unknown-kind','partial','{"futureField":{"keep":[1,2,3]}}'::jsonb)),
    jsonb_build_array(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-id:zero',0,'multibyte:漢字',false)))),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',90,2,95,null,0,null,0,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:α',0,'unknown-kind','partial','{"futureField":{"keep":[1,2,3]}}'::jsonb)),
    jsonb_build_array(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-id:zero',0,'multibyte:漢字',false)))),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',95,2))->>'revision','95','batch keeps sequence zero, partial event, unknown kind and payload fields');
select is((select archive_batch->>'batchBase64'
  from jsonb_array_elements(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'archiveBatches') as archive_batches(archive_batch)
  where archive_batch->>'revision'='95'),
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',90,2,95,null,0,null,0,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:α',0,'unknown-kind','partial','{"futureField":{"keep":[1,2,3]}}'::jsonb)),
    jsonb_build_array(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-id:zero',0,'multibyte:漢字',false)))),
  'stored batch is byte-exact after validation');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,95,2,'aaaaaaaa-0000-4000-8000-000000000034',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',95,2,96,0,0,0,0,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:repeat-zero',0,'duplicate','complete','null'::jsonb)),
    jsonb_build_array(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-id:repeat-zero',0,'repeat',true)))),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',95,2,96,0,0,0,0,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:repeat-zero',0,'duplicate','complete','null'::jsonb)),
    jsonb_build_array(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-id:repeat-zero',0,'repeat',true)))),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',96,2))$$,
  '22023','archive event is outside its declared range','a lower watermark of zero excludes sequence zero');
select is(public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,95,2,'aaaaaaaa-0000-4000-8000-000000000009',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',95,2,99,0,4,0,8,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:future',4,'vendor-kind','complete','{"nested":{"unknown":true},"api_key":"preserved payload"}'::jsonb)),
    jsonb_build_array(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-id:gap',8,'second-chunk',true)))),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',95,2,99,0,4,0,8,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:future',4,'vendor-kind','complete','{"nested":{"unknown":true},"api_key":"preserved payload"}'::jsonb)),
    jsonb_build_array(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-id:gap',8,'second-chunk',true)))),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2))->>'revision','99','sequence gaps are valid and archive payload field names remain opaque');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000035',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,0,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,0,4,8,8)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,
  '40001','archive batch sequence cursor is stale','the digest-bound event lower watermark must match accepted metadata');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000036',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,1,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,1,100,4,4,8,8)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,
  '22023','archive batch base or checkpoint revision is invalid','the batch ownership epoch must match the CAS epoch');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000010',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:replay-zero',0,'duplicate','complete','null'::jsonb)),
    jsonb_build_array(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-id:replay-zero',0,'replay',true)))),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:replay-zero',0,'duplicate','complete','null'::jsonb)),
    jsonb_build_array(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-id:replay-zero',0,'replay',true)))),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,
  '22023','archive event is outside its declared range','sequence zero cannot be replayed after the acknowledged watermarks advance');

-- Reject DTO mismatches, quarantine, unsupported extensions, and bad envelope facts before write.
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000011',
  pg_temp.kha41_b64(pg_temp.kha41_batch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',99,2,100,4,4,8,8)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,'22023',null,'batch game ID is bound to the actual digest payload');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000012',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',98,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',98,2,100,4,4,8,8)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,'22023',null,'batch base revision is bound to the transaction CAS');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000013',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,101,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,101,4,4,8,8)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,'22023',null,'batch checkpoint revision must match submitted checkpoint');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000014',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),repeat('0',64),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,'22023',null,'batch bytes must match the supplied outer digest');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000015',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:q',0,'opaque','complete','null'::jsonb)))),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8,
    jsonb_build_array(pg_temp.kha41_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','event-id:q',0,'opaque','complete','null'::jsonb)))),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,
  '22023','archive event is outside its declared range','event sequence zero is rejected below the acknowledged watermark');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000031',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  jsonb_set(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2)::jsonb,'{namespace,accountId}','null'::jsonb)::text)$$,
  '42501','checkpoint namespace is unavailable to this user','a null account namespace cannot pass owner binding');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000032',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2,
    '{"kind":"pending-adjudication","reason":null,"eventId":"pending:event","eventAtMs":1790000000100,"activeClockDeadlineMs":null}'::jsonb))$$,
  '22023','checkpoint.result has an unsupported pending reason','null is not a valid pending result reason');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000033',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  jsonb_set(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2)::jsonb,'{archive,egressStatus}','null'::jsonb)::text)$$,
  '22023','credential-quarantined game data cannot be uploaded','null does not clear the required eligible egress marker');

-- Repeated operations return their exact stored response, and changed inputs keep the ID reserved.
select is(public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,31,1,'aaaaaaaa-0000-4000-8000-000000000002',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,1,61,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,1,61,null,null,null,null)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',61,1))->>'revision','61','lost commit acknowledgment returns its original response after later cloud advancement');
select is(jsonb_array_length(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'archiveBatches'),7,'retry does not duplicate a batch');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,31,1,'aaaaaaaa-0000-4000-8000-000000000002',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,1,62,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,1,62,null,null,null,null)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',62,1))$$,
  '23505','operation ID was reused with different input','operation identity binds the complete checkpoint and batch request');
select is(public.cloud_read_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-0000-4000-8000-000000000009')->>'found','true','owner resolves a lost acknowledgment by operation ID');
select is(public.cloud_read_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-0000-4000-8000-000000000009')->'response'->>'revision','99','operation lookup returns the accepted sparse revision');
select is(public.cloud_read_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-0000-4000-8000-000000000099')->>'found','false','owner receives not-found for an unaccepted operation');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,31,2,'aaaaaaaa-0000-4000-8000-000000000020',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,2,62,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',31,2,62,null,null,null,null)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',62,2))$$,
  '40001','game revision is stale','stale revision is rejected after the operation identity lookup');

-- Account namespace, guest records, schema versions, unsupported extensions, and duplicate keys are rejected.
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000021',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2,
    p_version=>1::integer,p_namespace_kind=>'account'::text,p_account_id=>'22222222-2222-4222-8222-222222222222'::uuid))$$,
  '42501','checkpoint namespace is unavailable to this user','checkpoint account UUID must equal auth.uid');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000022',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2,
    p_version=>1::integer,p_namespace_kind=>'guest'::text,p_account_id=>null::uuid))$$,
  '42501','checkpoint namespace is unavailable to this user','guest namespace cannot be uploaded as an account game');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000023',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2,p_version=>2::integer))$$,
  '22023','game checkpoint identity or version is invalid','unknown checkpoint versions do not downgrade');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000024',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  jsonb_set(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2)::jsonb,'{extensions}','{"future":{"version":1,"data":{"retained":true}}}'::jsonb)::text)$$,
  '22023','unregistered checkpoint extensions are not accepted','unknown nonempty extensions are explicitly rejected');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000025',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  replace(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2),'"revision": 100','"revision": 100, "revision": 100'))$$,
  '22023','DTO contains duplicate object keys','checkpoint duplicate keys are detected before JSONB normalization');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000026',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  replace(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2),'"halfmoveClock": "0"','"halfmoveClock": "00"'))$$,
  '22023','checkpoint.rules.halfmoveClock must be an exact non-negative decimal string','decimal-string rules reject noncanonical values');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000027',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  jsonb_set(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2)::jsonb,'{archive,egressStatus}','"credential-echo-quarantined"'::jsonb)::text)$$,
  '22023','credential-quarantined game data cannot be uploaded','sticky checkpoint quarantine blocks cloud writes');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000028',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)),
  jsonb_set(pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2)::jsonb,'{selections,players,white}','{"kind":"human","api_key":"do-not-send"}'::jsonb)::text)$$,
  '22023',null,'nested secret-bearing selection fields are rejected by exact shape');

-- Batch duplicate keys and inner chunk digests fail before the checkpoint or sequence metadata changes.
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000029',
  encode(convert_to(replace(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)::text,'"format": "kamkmchess.cloud-archive-batch"','"format": "kamkmchess.cloud-archive-batch", "format": "kamkmchess.cloud-archive-batch"'),'UTF8'),'base64'),
  encode(extensions.digest(convert_to(replace(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,8)::text,'"format": "kamkmchess.cloud-archive-batch"','"format": "kamkmchess.cloud-archive-batch", "format": "kamkmchess.cloud-archive-batch"'),'UTF8'),'sha256'),'hex'),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,
  '22023','DTO contains duplicate object keys','batch duplicate keys are checked in digest-bound source bytes');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'aaaaaaaa-0000-4000-8000-000000000030',
  pg_temp.kha41_b64(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,9,'[]'::jsonb,
    jsonb_build_array(jsonb_set(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-bad',9,'wrong',true),'{sha256}',to_jsonb(repeat('0',64)))))),
  pg_temp.kha41_sha(pg_temp.kha41_batch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',99,2,100,4,4,8,9,'[]'::jsonb,
    jsonb_build_array(jsonb_set(pg_temp.kha41_chunk('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chunk-bad',9,'wrong',true),'{sha256}',to_jsonb(repeat('0',64)))))),
  pg_temp.kha41_checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100,2))$$,
  '22023','archive chunk digest does not match its bytes','inner chunk SHA-256 is checked independently of outer batch digest');

select is(public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->>'acceptedRevision','99','rejected DTO and archive inputs write no revision');
reset role;
select is((select count(*) from app_private.cloud_game_archive_items where game_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),4::bigint,'rejected archive batches add no item metadata');
set local role authenticated;

-- Create can atomically accept a nonempty bootstrap archive with sparse sequences.
select is(public.cloud_create_game('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'bbbbbbbb-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',31,0),
  pg_temp.kha41_b64(pg_temp.kha41_batch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',null,0,31,null,4,null,2,
    jsonb_build_array(
      pg_temp.kha41_event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','event:first',0,'unknown-event','partial','{"arbitrary":{"endpoint":"payload data","extra":[1,true,null]}}'::jsonb),
      pg_temp.kha41_event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','event:last',4,'future-kind','complete','{"opaque":"retained"}'::jsonb,array['chunk:raw'])) ,
    jsonb_build_array(pg_temp.kha41_chunk('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','chunk:raw',2,'bytes:雪',true)))),
  pg_temp.kha41_sha(pg_temp.kha41_batch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',null,0,31,null,4,null,2,
    jsonb_build_array(
      pg_temp.kha41_event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','event:first',0,'unknown-event','partial','{"arbitrary":{"endpoint":"payload data","extra":[1,true,null]}}'::jsonb),
      pg_temp.kha41_event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','event:last',4,'future-kind','complete','{"opaque":"retained"}'::jsonb,array['chunk:raw'])) ,
    jsonb_build_array(pg_temp.kha41_chunk('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','chunk:raw',2,'bytes:雪',true)))))->>'revision','31',
  'create accepts zero or many exact archive records in the initial batch');
select is(public.cloud_read_game('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->'archiveBatches'->0->>'batchBase64',
  pg_temp.kha41_b64(pg_temp.kha41_batch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',null,0,31,null,4,null,2,
    jsonb_build_array(
      pg_temp.kha41_event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','event:first',0,'unknown-event','partial','{"arbitrary":{"endpoint":"payload data","extra":[1,true,null]}}'::jsonb),
      pg_temp.kha41_event('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','event:last',4,'future-kind','complete','{"opaque":"retained"}'::jsonb,array['chunk:raw'])) ,
    jsonb_build_array(pg_temp.kha41_chunk('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','chunk:raw',2,'bytes:雪',true)))),
  'initial batch preserves all events, chunks, unknown payload fields, and multibyte chunk bytes');
select is(public.cloud_commit_game('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,31,1,'bbbbbbbb-0000-4000-8000-000000000002',
  pg_temp.kha41_b64(pg_temp.kha41_batch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',31,1,32,4,4,2,2)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',31,1,32,4,4,2,2)),
  jsonb_set(pg_temp.kha41_checkpoint('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',32,1)::jsonb,'{history,messages}',
    jsonb_build_array(jsonb_build_object('messageId','message:marker-text','segmentId','segment-id:α','lineId','line-id:current',
      'role','assistant','content','credential-echo-quarantined','eventIds','[]'::jsonb,'disposition','retained')))::text)->>'revision','32',
  'empty delta retains acknowledged watermarks and marker-like transcript text remains ordinary content');
select ok(public.cloud_read_game('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->'archiveBatches'->1->>'eventsAfterSequence'='4'
  and public.cloud_read_game('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->'archiveBatches'->1->>'eventsThroughSequence'='4'
  and public.cloud_read_game('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->'archiveBatches'->1->>'chunksAfterSequence'='2'
  and public.cloud_read_game('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->'archiveBatches'->1->>'chunksThroughSequence'='2',
  'empty delta records identical non-null sequence bounds');

select is(public.cloud_create_game('ffffffff-ffff-4fff-8fff-ffffffffffff',1,'ffffffff-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('ffffffff-ffff-4fff-8fff-ffffffffffff',6,0),
  pg_temp.kha41_b64(pg_temp.kha41_batch('ffffffff-ffff-4fff-8fff-ffffffffffff',null,0,6,null,4,null,null,
    jsonb_build_array(pg_temp.kha41_event('ffffffff-ffff-4fff-8fff-ffffffffffff','event:first-nonzero',4,'opaque','complete','{}'::jsonb)))),
  pg_temp.kha41_sha(pg_temp.kha41_batch('ffffffff-ffff-4fff-8fff-ffffffffffff',null,0,6,null,4,null,null,
    jsonb_build_array(pg_temp.kha41_event('ffffffff-ffff-4fff-8fff-ffffffffffff','event:first-nonzero',4,'opaque','complete','{}'::jsonb)))))->>'revision','6',
  'a first archive sequence may be nonzero when null lower bound means no prior records');

-- A first claim may also start from a checkpoint that is already final.
select is(public.cloud_create_game('cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,'cccccccc-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('cccccccc-cccc-4ccc-8ccc-cccccccccccc',12,0,
    '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:event","decidedAtMs":1790000000300}'::jsonb),
  pg_temp.kha41_b64(pg_temp.kha41_batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc',null,0,12,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc',null,0,12,null,null,null,null)))->'finalResult',
  '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:event","decidedAtMs":1790000000300}'::jsonb,
  'create latches an actual stalemate final result semantically');
select is(public.cloud_commit_game('cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,12,1,'cccccccc-0000-4000-8000-000000000002',
  pg_temp.kha41_b64(pg_temp.kha41_batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc',12,1,15,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc',12,1,15,null,null,null,null)),
  pg_temp.kha41_checkpoint('cccccccc-cccc-4ccc-8ccc-cccccccccccc',15,1,
    '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:event","decidedAtMs":1790000000300}'::jsonb),
  E' { "decidedAtMs" : 1790000000300, "eventId" : "final:event", "reason" : "stalemate", "winner" : "draw", "kind" : "final" } ')->>'revision',
  '15','create-latched final accepts equivalent JSON with different key order and spacing');
select throws_ok($$select public.cloud_commit_game('cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,15,1,'cccccccc-0000-4000-8000-000000000003',
  pg_temp.kha41_b64(pg_temp.kha41_batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc',15,1,16,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('cccccccc-cccc-4ccc-8ccc-cccccccccccc',15,1,16,null,null,null,null)),
  pg_temp.kha41_checkpoint('cccccccc-cccc-4ccc-8ccc-cccccccccccc',16,1,
    '{"kind":"final","winner":"white","reason":"timeout","eventId":"final:event","decidedAtMs":1790000000300}'::jsonb),
  '{"kind":"final","winner":"white","reason":"timeout","eventId":"final:event","decidedAtMs":1790000000300}')$$,
  '55000','a final result cannot be changed','a different final winner fails the immutable latch guard');

-- Pending adjudication is stored as mutable checkpoint data and does not populate final_result.
select is(public.cloud_create_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,'dddddddd-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,0,
    '{"kind":"pending-adjudication","reason":"checkmate","eventId":"pending:event","eventAtMs":1790000000000,"activeClockDeadlineMs":1790000000300}'::jsonb),
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',null,0,8,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',null,0,8,null,null,null,null)))->'finalResult','null'::jsonb,
  'pending-adjudication checkpoint does not latch a final result');
select throws_ok($$select public.cloud_commit_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,8,1,'dddddddd-0000-4000-8000-000000000010',
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,1,9,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,1,9,null,null,null,null)),
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',9,1,
    '{"kind":"pending-adjudication","reason":"checkmate","eventId":"pending:event","eventAtMs":1790000000000,"activeClockDeadlineMs":1790000000300}'::jsonb),
  '{"kind":"final","winner":"white","reason":"stalemate","eventId":"invalid:arg:white","decidedAtMs":1790000000000}')$$,
  '22023',null,'white stalemate is rejected in the separate final-result argument');
select throws_ok($$select public.cloud_commit_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,8,1,'dddddddd-0000-4000-8000-000000000011',
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,1,9,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,1,9,null,null,null,null)),
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',9,1,
    '{"kind":"pending-adjudication","reason":"checkmate","eventId":"pending:event","eventAtMs":1790000000000,"activeClockDeadlineMs":1790000000300}'::jsonb),
  '{"kind":"final","winner":"black","reason":"stalemate","eventId":"invalid:arg:black","decidedAtMs":1790000000000}')$$,
  '22023',null,'black stalemate is rejected in the separate final-result argument');
select is(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->>'acceptedRevision','8',
  'invalid final-result arguments do not advance the accepted revision');
select is(public.cloud_read_operation('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-0000-4000-8000-000000000010')->>'found','false',
  'invalid white final-result argument creates no operation receipt');
select is(public.cloud_read_operation('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-0000-4000-8000-000000000011')->>'found','false',
  'invalid black final-result argument creates no operation receipt');
select is(public.cloud_commit_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,8,1,'dddddddd-0000-4000-8000-000000000002',
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,1,10,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,1,10,null,null,null,null)),
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',10,1,
    '{"kind":"pending-adjudication","reason":"timeout","eventId":"pending:timeout","eventAtMs":1790000000100,"activeClockDeadlineMs":null}'::jsonb))->>'revision','10',
  'pending adjudication facts may change across checkpoints');
select is(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->'finalResult','null'::jsonb,'changing pending facts still leaves immutable final metadata empty');
select is(public.cloud_commit_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,10,1,'dddddddd-0000-4000-8000-000000000003',
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',10,1,14,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',10,1,14,null,null,null,null)),
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',14,1,
    '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:timeout","decidedAtMs":1790000000400}'::jsonb),
  '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:timeout","decidedAtMs":1790000000400}')->>'revision','14',
  'a later actual final can latch after mutable pending adjudication');
select is(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->'finalResult'->>'reason','stalemate','the final reason allowlist includes storage-approved stalemate');
select is(public.cloud_commit_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,14,1,'dddddddd-0000-4000-8000-000000000004',
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',14,1,16,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',14,1,16,null,null,null,null)),
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',16,1,
    '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:timeout","decidedAtMs":1790000000400}'::jsonb),
  E' { "decidedAtMs" : 1790000000400, "eventId" : "final:timeout", "reason" : "stalemate", "winner" : "draw", "kind" : "final" } ')->>'revision','16',
  'commit-latched final accepts equivalent JSON with different key order and spacing');
select throws_ok($$select public.cloud_commit_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,16,1,'dddddddd-0000-4000-8000-000000000005',
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',16,1,18,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',16,1,18,null,null,null,null)),
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',18,1,
    '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:timeout","decidedAtMs":1790000000400}'::jsonb),
  '{"kind":"final","winner":"white","reason":"timeout","eventId":"final:timeout","decidedAtMs":1790000000400}')$$,
  '55000','a final result cannot be changed','a changed final argument fails after the unchanged checkpoint passes validation');
select is(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->>'acceptedRevision','16',
  'a rejected final change does not advance the accepted revision');


-- A different authenticated account cannot discover or mutate owner data.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
select throws_ok($$select public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$,'42501','game is unavailable to this user','another account cannot read a checkpoint or archive page');
select throws_ok($$select public.cloud_read_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-0000-4000-8000-000000000009')$$,
  '42501','game is unavailable to this user','another account cannot resolve the owner operation ledger');
select throws_ok($$select public.cloud_commit_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,99,2,'22222222-0000-4000-8000-000000000001',
  'e30=','0000000000000000000000000000000000000000000000000000000000000000','{}')$$,
  '42501','game is unavailable to this user','another account cannot write even with guessed owner CAS values');
select throws_ok($$select * from app_private.cloud_game_archive_batches$$,'42501',null,'another account cannot bypass the archive RPC');

-- Anonymous access cannot invoke the owner RPC or read private rows.
reset role;
set local role anon;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"anon"}',true);
select throws_ok($$select public.cloud_read_game('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$,'42501',null,'unauthenticated session cannot execute cloud reads');
select throws_ok($$select * from app_private.cloud_games$$,'42501',null,'unauthenticated session cannot query private storage');

-- Deletion returns receipt-only results for every prior operation and erases game payload.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select is(public.cloud_read_operation('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-0000-4000-8000-000000000003')->'response'->'finalResult'->>'reason',
  'stalemate','accepted final is available to the owner before deletion');
select is(public.cloud_read_operation('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-0000-4000-8000-000000000004')->'response'->'finalResult'->>'reason',
  'stalemate','equivalent formatted final commit is resolvable before deletion');
select is(public.cloud_delete_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,16,1,'dddddddd-0000-4000-8000-000000000006')->>'receiptOnly','true',
  'delete atomically tombstones at accepted sparse revision plus one');
select is(public.cloud_delete_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,16,1,'dddddddd-0000-4000-8000-000000000006')->>'revision','17',
  'lost delete acknowledgment returns the original deletion receipt');
select is(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->>'deleted','true','owner reads a durable tombstone');
select is(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->>'receiptOnly','true','tombstone read returns an explicit deletion receipt');
select is(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->>'operationId','dddddddd-0000-4000-8000-000000000006',
  'tombstone receipt identifies the deletion operation without returning game payload');
select is(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',14,false,1,16,1,repeat('0',64))->>'receiptOnly','true',
  'a page arriving after deletion receives a detectable tombstone receipt');
select ok(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->'checkpoint'='null'::jsonb
  and jsonb_array_length(public.cloud_read_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd')->'archiveBatches')=0,
  'tombstone read carries no checkpoint or archive payload');
select is(public.cloud_read_operation('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-0000-4000-8000-000000000001')->'response'->>'receiptOnly','true',
  'operation lookup turns the original create result into a deletion-safe receipt');
select is(public.cloud_read_operation('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-0000-4000-8000-000000000003')->'response'->>'receiptOnly','true',
  'operation lookup turns the accepted final result into a deletion-safe receipt');
select is(public.cloud_read_operation('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-0000-4000-8000-000000000004')->'response'->>'receiptOnly','true',
  'operation lookup turns the equivalent formatted final commit into a deletion-safe receipt');
select ok(not (public.cloud_read_operation('dddddddd-dddd-4ddd-8ddd-dddddddddddd','dddddddd-0000-4000-8000-000000000003')->'response' ? 'finalResult'),
  'deleted operation receipt contains no final-result payload');
select is(public.cloud_commit_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,10,1,'dddddddd-0000-4000-8000-000000000003',
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',10,1,14,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',10,1,14,null,null,null,null)),
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',14,1,
    '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:timeout","decidedAtMs":1790000000400}'::jsonb),
  '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:timeout","decidedAtMs":1790000000400}')->>'receiptOnly','true',
  'retry of an accepted predelete final commit returns a receipt without resurrecting payload');
select is(public.cloud_commit_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,14,1,'dddddddd-0000-4000-8000-000000000004',
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',14,1,16,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',14,1,16,null,null,null,null)),
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',16,1,
    '{"kind":"final","winner":"draw","reason":"stalemate","eventId":"final:timeout","decidedAtMs":1790000000400}'::jsonb),
  E' { "decidedAtMs" : 1790000000400, "eventId" : "final:timeout", "reason" : "stalemate", "winner" : "draw", "kind" : "final" } ')->>'receiptOnly','true',
  'retry of the later equivalent-final commit returns a receipt after deletion');
reset role;
select ok(not exists(select 1 from app_private.cloud_games where game_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  and not exists(select 1 from app_private.cloud_game_ownership where game_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  and not exists(select 1 from app_private.cloud_game_checkpoints where game_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  and not exists(select 1 from app_private.cloud_game_archive_batches where game_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  and not exists(select 1 from app_private.cloud_game_archive_items where game_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  'delete removes metadata, checkpoint, batch bytes, and archive indexes');
select ok(not exists(select 1 from app_private.cloud_game_outbox o where o.game_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  and (o.response ? 'finalResult' or o.response ? 'batchBase64' or o.response ? 'archiveBatches')),
  'all persisted operation responses are payload-free after deletion');
set local role authenticated;
select is(public.cloud_create_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,'dddddddd-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,0,
    '{"kind":"pending-adjudication","reason":"checkmate","eventId":"pending:event","eventAtMs":1790000000000,"activeClockDeadlineMs":1790000000300}'::jsonb),
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',null,0,8,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',null,0,8,null,null,null,null)))->>'receiptOnly','true',
  'retry of the original predelete create returns a deletion-safe receipt');
select throws_ok($$select public.cloud_create_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,'dddddddd-0000-4000-8000-000000000001',
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,0),
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',null,0,8,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',null,0,8,null,null,null,null)))$$,
  '23505','game identifier or operation ID is unavailable','changed input cannot reuse a deleted create operation ID');
select throws_ok($$select public.cloud_create_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,'dddddddd-0000-4000-8000-000000000005',
  pg_temp.kha41_checkpoint('dddddddd-dddd-4ddd-8ddd-dddddddddddd',8,0),
  pg_temp.kha41_b64(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',null,0,8,null,null,null,null)),
  pg_temp.kha41_sha(pg_temp.kha41_batch('dddddddd-dddd-4ddd-8ddd-dddddddddddd',null,0,8,null,null,null,null)))$$,
  '23505','game identifier or operation ID is unavailable','a fresh operation cannot recreate a tombstoned game UUID');
select throws_ok($$select public.cloud_delete_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,16,1,'dddddddd-0000-4000-8000-000000000009')$$,
  '55000','game has been deleted','new delete ID cannot advance an existing tombstone');
select throws_ok($$select public.cloud_commit_game('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,16,1,'dddddddd-0000-4000-8000-000000000007','e30=','0000000000000000000000000000000000000000000000000000000000000000','{}')$$,
  '55000','game has been deleted','new cloud commit cannot resurrect a tombstoned UUID');

reset role;
select * from extensions.finish();
rollback;
