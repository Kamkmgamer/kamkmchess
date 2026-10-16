import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const migrationUrl = new URL(
  "../../migrations/20261016000100_owner_only_cloud_storage.sql",
  import.meta.url,
);
const fixtureUrl = new URL("../kha41_cloud_storage.sql", import.meta.url);
const probeBundleUrl = new URL("./vendor/pgtap-1.3.3.tar.gz", import.meta.url);
const expectedPgtapBundleSha256 =
  "1f0f4c4d874f76b6b66a0e88ec1f4a78a26c1cdb1c8db2c38918ca8ee2de8ea3";
const expectedFixtureAssertions = 132;

const syntheticOwner = "33333333-3333-4333-8333-333333333333";
const syntheticEmail = "kha41-local-probe@example.invalid";
const probeResults = [];

const pgtap = {
  name: "pgtap",
  setup: async () => ({ bundlePath: probeBundleUrl }),
};

function assertionLines(results) {
  return results.flatMap((result) =>
    (result.rows ?? []).flatMap((row) =>
      Object.values(row).filter(
        (value) => typeof value === "string" && /^(?:not )?ok \d+ - /.test(value),
      ),
    ),
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkpoint(gameId, revision, ownershipEpoch, result = { kind: "unresolved" }) {
  const segmentId = `segment:${gameId}`;
  return JSON.stringify({
    schemaVersion: 1,
    gameId,
    namespace: { kind: "account", accountId: syntheticOwner },
    revision,
    ownershipEpoch,
    segmentId,
    positionRevision: 7,
    requestGeneration: 11,
    analysisGeneration: 13,
    updatedAtMs: 1790000000123,
    rules: {
      variant: "orthodox",
      startingFen: "start fen",
      currentFen: "current fen",
      sideToMove: "white",
      castlingRights: "KQkq",
      enPassantSquare: null,
      halfmoveClock: "0",
      fullmoveNumber: "1",
      repetitionLedger: {
        version: 1,
        positions: [{ identity: "position-key", occurrences: "1" }],
      },
      moves: [],
    },
    history: {
      currentSegmentId: segmentId,
      segments: [
        {
          segmentId,
          providerId: "provider:raw",
          modelRoutingId: "model:raw",
          connectionRevision: 2,
          startedAtMs: 1780000000000,
          messageIds: [],
        },
      ],
      messages: [],
    },
    clocks: {
      schemaVersion: 1,
      timeControl: { startingTimeMs: 60000, incrementMs: 1000 },
      banksAtAnchor: { whiteMs: 59000, blackMs: 60000 },
      activeSide: "white",
      anchor: { monotonicMs: 100.5, wallTimeMs: 1790000000001, hostOffsetMs: 12.25 },
      lastReconciledAtMs: 1790000000002,
    },
    budgets: {
      formattingCorrectionsRemaining: 3,
      illegalMoveAttemptsRemaining: { white: 4, black: 5 },
      manualRetriesBySide: { white: 6, black: 7 },
    },
    selections: {
      players: {
        white: { kind: "human" },
        black: {
          kind: "model",
          providerId: "provider-id",
          connectionId: "connection-id",
          configurationRevision: 3,
          modelRoutingId: "route-id",
          protocol: "custom",
          diagnostic: "unknown",
        },
      },
    },
    archive: {
      egressStatus: "eligible",
      currentLine: { lineId: "line-id:current", eventIds: [] },
      discardedLines: [],
    },
    result,
    practice: {
      mode: "ordinary",
      scored: false,
      sourceGameId: null,
      sourcePositionFen: null,
      originalResult: null,
    },
    extensions: {},
  });
}

function archiveEvent(gameId, eventId, sequence, kind, receiveState, payload, chunkIds = []) {
  return {
    eventId,
    gameId,
    sequence,
    segmentId: `segment:${gameId}`,
    kind,
    occurredAtMs: 1790000000100 + sequence,
    receiveState,
    egressStatus: "eligible",
    payload,
    chunkIds,
  };
}

function archiveChunk(gameId, chunkId, sequence, text, isFinal = false) {
  const bytes = Buffer.from(text, "utf8");
  return {
    chunkId,
    gameId,
    sequence,
    receivedAtMs: 1790000000200 + sequence,
    isFinal,
    egressStatus: "eligible",
    bytesBase64: bytes.toString("base64"),
    sha256: sha256(bytes),
  };
}

function archiveBatch({
  gameId,
  baseRevision,
  baseOwnershipEpoch,
  checkpointRevision,
  eventsAfterSequence = null,
  eventsThroughSequence = null,
  chunksAfterSequence = null,
  chunksThroughSequence = null,
  events = [],
  chunks = [],
}) {
  const body = JSON.stringify({
    format: "kamkmchess.cloud-archive-batch",
    schemaVersion: 1,
    gameId,
    baseRevision,
    baseOwnershipEpoch,
    checkpointRevision,
    eventsAfterSequence,
    eventsThroughSequence,
    chunksAfterSequence,
    chunksThroughSequence,
    events,
    chunks,
  });
  const bytes = Buffer.from(body, "utf8");
  return { body, base64: bytes.toString("base64"), sha256: sha256(bytes) };
}

function createGameSql() {
  return `
    select public.cloud_create_game(
      $1::uuid,
      1,
      $2::uuid,
      $3::text,
      $4::text,
      $5::text
    ) as response
  `;
}

function commitGameSql() {
  return `
    select public.cloud_commit_game(
      $1::uuid,
      1,
      $2::bigint,
      $3::bigint,
      $4::uuid,
      $5::text,
      $6::text,
      $7::text,
      $8::text
    ) as response
  `;
}

async function createGame(db, { gameId, operationId, checkpointDto, batch }) {
  const result = await db.query(createGameSql(), [
    gameId,
    operationId,
    checkpointDto,
    batch.base64,
    batch.sha256,
  ]);
  return result.rows[0].response;
}

async function commitGame(db, {
  gameId,
  expectedRevision,
  expectedEpoch,
  operationId,
  checkpointDto,
  batch,
  finalResult = null,
}) {
  const result = await db.query(commitGameSql(), [
    gameId,
    expectedRevision,
    expectedEpoch,
    operationId,
    batch.base64,
    batch.sha256,
    checkpointDto,
    finalResult,
  ]);
  return result.rows[0].response;
}

async function readGame(db, gameId, {
  afterRevision = 0,
  includeCheckpoint = true,
  pageLimit = 20,
  throughRevision = null,
  targetEpoch = null,
  targetCheckpointSha256 = null,
} = {}) {
  const result = await db.query(
    `select public.cloud_read_game($1::uuid,$2::bigint,$3::boolean,$4::integer,$5::bigint,$6::bigint,$7::text) as response`,
    [gameId, afterRevision, includeCheckpoint, pageLimit, throughRevision, targetEpoch, targetCheckpointSha256],
  );
  return result.rows[0].response;
}

async function readOperation(db, gameId, operationId) {
  const result = await db.query(
    "select public.cloud_read_operation($1::uuid,$2::uuid) as response",
    [gameId, operationId],
  );
  return result.rows[0].response;
}

function log(...parts) {
  process.stdout.write(`${parts.join(" ")}\n`);
}

function recordProbe(name, expected, observed, passed) {
  probeResults.push({ name, expected, observed, passed });
  log(`${passed ? "PASS" : "FAIL"} ${name}`);
  log(`  expected: ${expected}`);
  log(`  observed: ${observed}`);
}

function sqlError(error) {
  const fields = [
    ["detail", error.detail],
    ["hint", error.hint],
    ["position", error.position],
    ["internal position", error.internalPosition],
    ["internal query", error.internalQuery],
    ["context", error.where],
    ["schema", error.schema],
    ["table", error.table],
    ["column", error.column],
    ["routine", error.routine],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  const diagnostics = fields.map(([label, value]) => `${label}: ${String(value).replace(/\s+/g, " ")}`);
  return [`${error.code ?? "unknown"}: ${error.message}`, ...diagnostics].join(" | ");
}

function sourcePosition(source, position) {
  const offset = Number(position);
  if (!Number.isInteger(offset) || offset < 1) return "";
  const prefix = source.slice(0, offset - 1);
  const lines = prefix.split(/\r\n|\r|\n/);
  const lineNumber = lines.length;
  const columnNumber = lines.at(-1).length + 1;
  const sourceLine = source.split(/\r\n|\r|\n/)[lineNumber - 1] ?? "";
  return ` | source line ${lineNumber}, column ${columnNumber}: ${sourceLine}\n  ${" ".repeat(columnNumber - 1)}^`;
}

async function capture(action) {
  try {
    return { value: await action() };
  } catch (error) {
    return { error };
  }
}

function describe(outcome, valueDescription) {
  if (outcome.error) return sqlError(outcome.error);
  return valueDescription(outcome.value);
}

async function runPublicRpcProbes(db) {
  await db.exec(`
    insert into auth.users (id,aud,role,email)
    values ('${syntheticOwner}','authenticated','authenticated','${syntheticEmail}');
    set role authenticated;
    select pg_catalog.set_config('request.jwt.claim.sub','${syntheticOwner}',false);
    select pg_catalog.set_config(
      'request.jwt.claims',
      '{"sub":"${syntheticOwner}","role":"authenticated"}',
      false
    );
  `);

  const sparseGame = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const createOperation = "dddddddd-0000-4000-8000-000000000001";
  const commit61Operation = "dddddddd-0000-4000-8000-000000000002";
  const commit70Operation = "dddddddd-0000-4000-8000-000000000003";
  const takeoverOperation = "dddddddd-0000-4000-8000-000000000004";
  const commit75Operation = "dddddddd-0000-4000-8000-000000000005";
  const firstCheckpoint = checkpoint(sparseGame, 31, 0);
  const firstBatch = archiveBatch({
    gameId: sparseGame,
    baseRevision: null,
    baseOwnershipEpoch: 0,
    checkpointRevision: 31,
    eventsThroughSequence: 4,
    chunksThroughSequence: 2,
    events: [
      archiveEvent(sparseGame, "event:zero", 0, "unknown-kind", "partial", {
        arbitrary: { endpoint: "opaque payload data", retained: [1, true, null] },
      }),
      archiveEvent(
        sparseGame,
        "event:four",
        4,
        "future-event",
        "complete",
        { retained: "unchanged" },
        ["chunk:two"],
      ),
    ],
    chunks: [archiveChunk(sparseGame, "chunk:two", 2, "multibyte archive: 雪", true)],
  });

  const createOutcome = await capture(() => createGame(db, {
    gameId: sparseGame,
    operationId: createOperation,
    checkpointDto: firstCheckpoint,
    batch: firstBatch,
  }));
  const createdReadOutcome = await capture(() => readGame(db, sparseGame));
  const createPassed =
    !createOutcome.error &&
    createOutcome.value.revision === 31 &&
    createOutcome.value.ownershipEpoch === 1 &&
    !createdReadOutcome.error &&
    createdReadOutcome.value.acceptedRevision === 31 &&
    createdReadOutcome.value.ownershipEpoch === 1 &&
    createdReadOutcome.value.checkpoint?.payload === firstCheckpoint &&
    createdReadOutcome.value.checkpoint?.ownershipEpoch === 1;
  recordProbe(
    "create accepts sparse local revision 31 and preserves epoch-zero checkpoint under cloud epoch one",
    "accepted revision 31, cloud epoch 1, exact submitted checkpoint with ownershipEpoch 0",
    createOutcome.error
      ? sqlError(createOutcome.error)
      : createdReadOutcome.error
        ? sqlError(createdReadOutcome.error)
        : `accepted revision ${createdReadOutcome.value.acceptedRevision}, cloud epoch ${createdReadOutcome.value.ownershipEpoch}, checkpoint text ${createdReadOutcome.value.checkpoint?.payload === firstCheckpoint ? "byte-for-byte unchanged" : "changed"}`,
    createPassed,
  );

  const archivePassed =
    !createdReadOutcome.error &&
    createdReadOutcome.value.archiveBatches?.length === 1 &&
    createdReadOutcome.value.archiveBatches[0].batchBase64 === firstBatch.base64 &&
    createdReadOutcome.value.archiveBatches[0].sha256 === firstBatch.sha256;
  recordProbe(
    "create stores digest-bound archive bytes including sequence zero, gaps, and multibyte chunk data",
    "one batch returned with the exact submitted Base64 and SHA-256",
    createdReadOutcome.error
      ? sqlError(createdReadOutcome.error)
      : `batch count ${createdReadOutcome.value.archiveBatches?.length ?? 0}, exact bytes ${archivePassed}`,
    archivePassed,
  );

  const emptyDelta61 = archiveBatch({
    gameId: sparseGame,
    baseRevision: 31,
    baseOwnershipEpoch: 1,
    checkpointRevision: 61,
    eventsAfterSequence: 4,
    eventsThroughSequence: 4,
    chunksAfterSequence: 2,
    chunksThroughSequence: 2,
  });
  const checkpoint61 = checkpoint(sparseGame, 61, 1);
  const commit61Outcome = await capture(() => commitGame(db, {
    gameId: sparseGame,
    expectedRevision: 31,
    expectedEpoch: 1,
    operationId: commit61Operation,
    checkpointDto: checkpoint61,
    batch: emptyDelta61,
  }));
  const commit61Passed = !commit61Outcome.error && commit61Outcome.value.revision === 61;
  recordProbe(
    "commit coalesces local checkpoints into sparse revision 61 and carries known empty archive watermarks",
    "CAS from revision 31 accepts revision 61 without synthesizing intermediate rows",
    describe(commit61Outcome, (response) => `accepted revision ${response.revision}, cloud epoch ${response.ownershipEpoch}`),
    commit61Passed,
  );

  if (!commit61Passed) {
    await runCommitFailureFallback(db, {
      gameId: sparseGame,
      createOperation,
      firstCheckpoint,
      firstBatch,
    });
    await runPendingCreateProbe(db);
    await db.exec("reset role;");
    return;
  }

  const firstPageOutcome = await capture(() => readGame(db, sparseGame, {
    pageLimit: 1,
  }));
  const frozen = firstPageOutcome.value;
  const expectedCheckpointSha = sha256(Buffer.from(checkpoint61, "utf8"));
  const frozenTargetPassed =
    !firstPageOutcome.error &&
    frozen.throughRevision === 61 &&
    frozen.targetEpoch === 1 &&
    frozen.targetCheckpointSha256 === expectedCheckpointSha &&
    frozen.archiveBatches?.[0]?.revision === 31 &&
    frozen.hasMore === true;
  recordProbe(
    "first bounded read freezes revision, cloud epoch, and exact checkpoint digest",
    "target 61/epoch 1, digest of exact checkpoint, first batch only, hasMore true",
    describe(firstPageOutcome, (response) => `target ${response.throughRevision}/epoch ${response.targetEpoch}, first batch ${response.archiveBatches?.[0]?.revision}, hasMore ${response.hasMore}`),
    frozenTargetPassed,
  );

  const deltaBatch70 = archiveBatch({
    gameId: sparseGame,
    baseRevision: 61,
    baseOwnershipEpoch: 1,
    checkpointRevision: 70,
    eventsAfterSequence: 4,
    eventsThroughSequence: 8,
    chunksAfterSequence: 2,
    chunksThroughSequence: 7,
    events: [archiveEvent(sparseGame, "event:eight", 8, "future-kind", "complete", {
      unknownField: { preserve: true },
    })],
    chunks: [archiveChunk(sparseGame, "chunk:seven", 7, "delta bytes", false)],
  });
  const checkpoint70 = checkpoint(sparseGame, 70, 1);
  const commit70Outcome = await capture(() => commitGame(db, {
    gameId: sparseGame,
    expectedRevision: 61,
    expectedEpoch: 1,
    operationId: commit70Operation,
    checkpointDto: checkpoint70,
    batch: deltaBatch70,
  }));
  const commit70Passed = !commit70Outcome.error && commit70Outcome.value.revision === 70;
  recordProbe(
    "archive delta accepts gapped sequence bounds after the frozen read target",
    "revision 70 accepted with event sequence 8 after 4 and chunk sequence 7 after 2",
    describe(commit70Outcome, (response) => `accepted revision ${response.revision}, cloud epoch ${response.ownershipEpoch}`),
    commit70Passed,
  );

  const secondPageOutcome = await capture(() => readGame(db, sparseGame, {
    afterRevision: 31,
    includeCheckpoint: false,
    pageLimit: 1,
    throughRevision: frozen?.throughRevision,
    targetEpoch: frozen?.targetEpoch,
    targetCheckpointSha256: frozen?.targetCheckpointSha256,
  }));
  const frozenPagePassed =
    !secondPageOutcome.error &&
    secondPageOutcome.value.throughRevision === 61 &&
    secondPageOutcome.value.archiveBatches?.length === 1 &&
    secondPageOutcome.value.archiveBatches[0].revision === 61 &&
    secondPageOutcome.value.hasMore === false;
  recordProbe(
    "later page stays within its frozen target after a newer sparse commit",
    "returns revision 61 batch only and excludes revision 70",
    describe(secondPageOutcome, (response) => `target ${response.throughRevision}, batches ${response.archiveBatches?.map((item) => item.revision).join(",") ?? "none"}, hasMore ${response.hasMore}`),
    frozenPagePassed,
  );

  const operationReadOutcome = await capture(() => readOperation(db, sparseGame, commit61Operation));
  const missingOperationOutcome = await capture(() => readOperation(
    db,
    sparseGame,
    "dddddddd-0000-4000-8000-000000000099",
  ));
  const operationLookupPassed =
    !operationReadOutcome.error &&
    operationReadOutcome.value.found === true &&
    operationReadOutcome.value.response?.revision === 61 &&
    !missingOperationOutcome.error &&
    missingOperationOutcome.value.found === false;
  recordProbe(
    "public operation lookup resolves accepted sparse revision and reports unknown IDs",
    "accepted operation returns revision 61; unknown operation returns found false",
    operationReadOutcome.error
      ? sqlError(operationReadOutcome.error)
      : missingOperationOutcome.error
        ? sqlError(missingOperationOutcome.error)
        : `found ${operationReadOutcome.value.found} at revision ${operationReadOutcome.value.response?.revision}; unknown found ${missingOperationOutcome.value.found}`,
    operationLookupPassed,
  );

  const takeoverOutcome = await capture(async () => {
    const query = await db.query(
      "select public.cloud_takeover_game($1::uuid,1,70,1,$2::uuid) as response",
      [sparseGame, takeoverOperation],
    );
    return query.rows[0].response;
  });
  const afterTakeoverOutcome = await capture(() => readGame(db, sparseGame));
  const takeoverPassed =
    !takeoverOutcome.error &&
    takeoverOutcome.value.ownershipEpoch === 2 &&
    !afterTakeoverOutcome.error &&
    afterTakeoverOutcome.value.ownershipEpoch === 2 &&
    afterTakeoverOutcome.value.acceptedRevision === 70 &&
    afterTakeoverOutcome.value.checkpoint?.payload === checkpoint70 &&
    afterTakeoverOutcome.value.checkpoint?.ownershipEpoch === 1;
  recordProbe(
    "takeover advances cloud epoch without rewriting the accepted checkpoint",
    "cloud epoch 2 while accepted revision 70 retains exact checkpoint epoch 1",
    takeoverOutcome.error
      ? sqlError(takeoverOutcome.error)
      : afterTakeoverOutcome.error
        ? sqlError(afterTakeoverOutcome.error)
        : `cloud epoch ${afterTakeoverOutcome.value.ownershipEpoch}, accepted revision ${afterTakeoverOutcome.value.acceptedRevision}, checkpoint epoch ${afterTakeoverOutcome.value.checkpoint?.ownershipEpoch}, checkpoint text ${afterTakeoverOutcome.value.checkpoint?.payload === checkpoint70 ? "unchanged" : "changed"}`,
    takeoverPassed,
  );

  const staleTargetOutcome = await capture(() => readGame(db, sparseGame, {
    afterRevision: 61,
    includeCheckpoint: false,
    pageLimit: 1,
    throughRevision: frozen?.throughRevision,
    targetEpoch: frozen?.targetEpoch,
    targetCheckpointSha256: frozen?.targetCheckpointSha256,
  }));
  const staleTargetPassed =
    staleTargetOutcome.error?.code === "40001";
  recordProbe(
    "frozen read target becomes detectably stale after takeover",
    "reject with SQLSTATE 40001 so the reader restarts",
    staleTargetOutcome.error
      ? sqlError(staleTargetOutcome.error)
      : `unexpectedly returned target ${staleTargetOutcome.value.throughRevision}`,
    staleTargetPassed,
  );

  const adoptedCheckpoint75 = checkpoint(sparseGame, 75, 2);
  const deltaBatch75 = archiveBatch({
    gameId: sparseGame,
    baseRevision: 70,
    baseOwnershipEpoch: 2,
    checkpointRevision: 75,
    eventsAfterSequence: 8,
    eventsThroughSequence: 8,
    chunksAfterSequence: 7,
    chunksThroughSequence: 7,
  });
  const adoptedCommitOutcome = await capture(() => commitGame(db, {
    gameId: sparseGame,
    expectedRevision: 70,
    expectedEpoch: 2,
    operationId: commit75Operation,
    checkpointDto: adoptedCheckpoint75,
    batch: deltaBatch75,
  }));
  const adoptedCommitPassed =
    !adoptedCommitOutcome.error && adoptedCommitOutcome.value.revision === 75;
  recordProbe(
    "new owner adopts the acknowledged cloud epoch in a later sparse checkpoint",
    "revision 75 at cloud epoch 2 accepted after takeover",
    describe(adoptedCommitOutcome, (response) => `accepted revision ${response.revision}, cloud epoch ${response.ownershipEpoch}`),
    adoptedCommitPassed,
  );

  await runPendingAndFinalProbes(db);
  await db.exec("reset role;");
}

async function runCommitFailureFallback(db, { gameId, createOperation, firstCheckpoint, firstBatch }) {
  const firstPageOutcome = await capture(() => readGame(db, gameId, { pageLimit: 1 }));
  const firstPage = firstPageOutcome.value;
  const firstPageSha = sha256(Buffer.from(firstCheckpoint, "utf8"));
  const firstPagePassed =
    !firstPageOutcome.error &&
    firstPage.throughRevision === 31 &&
    firstPage.targetEpoch === 1 &&
    firstPage.targetCheckpointSha256 === firstPageSha &&
    firstPage.archiveBatches?.[0]?.revision === 31 &&
    firstPage.hasMore === false;
  recordProbe(
    "bounded read returns its first frozen checkpoint target",
    "target revision 31/epoch 1 with digest of the exact checkpoint",
    describe(firstPageOutcome, (response) => `target ${response.throughRevision}/epoch ${response.targetEpoch}, batch ${response.archiveBatches?.[0]?.revision}, hasMore ${response.hasMore}`),
    firstPagePassed,
  );

  const operationReadOutcome = await capture(() => readOperation(db, gameId, createOperation));
  const missingOperationOutcome = await capture(() => readOperation(
    db,
    gameId,
    "dddddddd-0000-4000-8000-000000000099",
  ));
  const lookupPassed =
    !operationReadOutcome.error &&
    operationReadOutcome.value.found === true &&
    operationReadOutcome.value.response?.revision === 31 &&
    !missingOperationOutcome.error &&
    missingOperationOutcome.value.found === false;
  recordProbe(
    "operation lookup resolves the create response and reports an unknown ID",
    "create response found at revision 31; missing operation returns found false",
    operationReadOutcome.error
      ? sqlError(operationReadOutcome.error)
      : missingOperationOutcome.error
        ? sqlError(missingOperationOutcome.error)
        : `found ${operationReadOutcome.value.found} at revision ${operationReadOutcome.value.response?.revision}; missing found ${missingOperationOutcome.value.found}`,
    lookupPassed,
  );

  const takeoverOperation = "dddddddd-0000-4000-8000-000000000004";
  const takeoverOutcome = await capture(async () => {
    const result = await db.query(
      "select public.cloud_takeover_game($1::uuid,1,31,1,$2::uuid) as response",
      [gameId, takeoverOperation],
    );
    return result.rows[0].response;
  });
  const afterTakeoverOutcome = await capture(() => readGame(db, gameId));
  const takeoverPassed =
    !takeoverOutcome.error &&
    takeoverOutcome.value.ownershipEpoch === 2 &&
    !afterTakeoverOutcome.error &&
    afterTakeoverOutcome.value.acceptedRevision === 31 &&
    afterTakeoverOutcome.value.ownershipEpoch === 2 &&
    afterTakeoverOutcome.value.checkpoint?.payload === firstCheckpoint &&
    afterTakeoverOutcome.value.checkpoint?.ownershipEpoch === 1;
  recordProbe(
    "takeover advances cloud epoch without rewriting the epoch-zero checkpoint",
    "accepted revision 31 remains exact; cloud epoch advances to 2",
    takeoverOutcome.error
      ? sqlError(takeoverOutcome.error)
      : afterTakeoverOutcome.error
        ? sqlError(afterTakeoverOutcome.error)
        : `accepted revision ${afterTakeoverOutcome.value.acceptedRevision}, cloud epoch ${afterTakeoverOutcome.value.ownershipEpoch}, checkpoint row epoch ${afterTakeoverOutcome.value.checkpoint?.ownershipEpoch}, checkpoint text ${afterTakeoverOutcome.value.checkpoint?.payload === firstCheckpoint ? "unchanged" : "changed"}`,
    takeoverPassed,
  );

  const stalePageOutcome = await capture(() => readGame(db, gameId, {
    afterRevision: 0,
    includeCheckpoint: false,
    pageLimit: 1,
    throughRevision: firstPage?.throughRevision,
    targetEpoch: firstPage?.targetEpoch,
    targetCheckpointSha256: firstPage?.targetCheckpointSha256,
  }));
  const stalePagePassed = stalePageOutcome.error?.code === "40001";
  recordProbe(
    "frozen read target becomes detectably stale after takeover",
    "reject with SQLSTATE 40001 so the reader restarts",
    stalePageOutcome.error
      ? sqlError(stalePageOutcome.error)
      : `unexpectedly returned target ${stalePageOutcome.value.throughRevision}`,
    stalePagePassed,
  );

  const deleteOperation = "dddddddd-0000-4000-8000-000000000006";
  const deleteOutcome = await capture(async () => {
    const result = await db.query(
      "select public.cloud_delete_game($1::uuid,1,31,2,$2::uuid) as response",
      [gameId, deleteOperation],
    );
    return result.rows[0].response;
  });
  const readOperationAfterDelete = await capture(() => readOperation(db, gameId, createOperation));
  const tombstoneOutcome = await capture(() => readGame(db, gameId));
  const createRetryOutcome = await capture(() => createGame(db, {
    gameId,
    operationId: createOperation,
    checkpointDto: firstCheckpoint,
    batch: firstBatch,
  }));
  const deletionReceiptsPassed =
    !deleteOutcome.error &&
    deleteOutcome.value.receiptOnly === true &&
    !readOperationAfterDelete.error &&
    readOperationAfterDelete.value.response?.receiptOnly === true &&
    !Object.hasOwn(readOperationAfterDelete.value.response, "finalResult") &&
    !tombstoneOutcome.error &&
    tombstoneOutcome.value.deleted === true &&
    tombstoneOutcome.value.receiptOnly === true &&
    !tombstoneOutcome.value.checkpoint &&
    tombstoneOutcome.value.archiveBatches?.length === 0 &&
    !createRetryOutcome.error &&
    createRetryOutcome.value.receiptOnly === true &&
    !Object.hasOwn(createRetryOutcome.value, "finalResult");
  recordProbe(
    "delete lookup and exact create retry return payload-free receipts",
    "tombstone, operation read, and matching retry omit checkpoint, archive, and final-result payload",
    deleteOutcome.error
      ? sqlError(deleteOutcome.error)
      : readOperationAfterDelete.error
        ? sqlError(readOperationAfterDelete.error)
        : tombstoneOutcome.error
          ? sqlError(tombstoneOutcome.error)
          : createRetryOutcome.error
            ? sqlError(createRetryOutcome.error)
            : `delete receipt ${deleteOutcome.value.receiptOnly}, operation receipt ${readOperationAfterDelete.value.response?.receiptOnly}, retry receipt ${createRetryOutcome.value.receiptOnly}, tombstone batches ${tombstoneOutcome.value.archiveBatches?.length}`,
    deletionReceiptsPassed,
  );
}

async function runPendingCreateProbe(db) {
  const gameId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const pending = {
    kind: "pending-adjudication",
    reason: "checkmate",
    eventId: "pending:event",
    eventAtMs: 1790000000000,
    activeClockDeadlineMs: 1790000000300,
  };
  const result = await capture(() => createGame(db, {
    gameId,
    operationId: "eeeeeeee-0000-4000-8000-000000000001",
    checkpointDto: checkpoint(gameId, 8, 0, pending),
    batch: archiveBatch({
      gameId,
      baseRevision: null,
      baseOwnershipEpoch: 0,
      checkpointRevision: 8,
    }),
  }));
  const passed = !result.error && result.value.finalResult === null;
  recordProbe(
    "pending adjudication at create leaves immutable final metadata empty",
    "create succeeds with finalResult null",
    describe(result, (response) => `finalResult ${JSON.stringify(response.finalResult)}`),
    passed,
  );
  log("SKIP pending updates, final-result latch checks, and later commits because the source commit RPC fails before CAS validation.");
}

async function runPendingAndFinalProbes(db) {
  const gameId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const createOperation = "eeeeeeee-0000-4000-8000-000000000001";
  const pendingUpdateOperation = "eeeeeeee-0000-4000-8000-000000000002";
  const finalOperation = "eeeeeeee-0000-4000-8000-000000000003";
  const equalFinalOperation = "eeeeeeee-0000-4000-8000-000000000004";
  const changedFinalOperation = "eeeeeeee-0000-4000-8000-000000000005";
  const initialPending = {
    kind: "pending-adjudication",
    reason: "checkmate",
    eventId: "pending:event",
    eventAtMs: 1790000000000,
    activeClockDeadlineMs: 1790000000300,
  };
  const initialCheckpoint = checkpoint(gameId, 8, 0, initialPending);
  const initialBatch = archiveBatch({
    gameId,
    baseRevision: null,
    baseOwnershipEpoch: 0,
    checkpointRevision: 8,
  });
  const createOutcome = await capture(() => createGame(db, {
    gameId,
    operationId: createOperation,
    checkpointDto: initialCheckpoint,
    batch: initialBatch,
  }));
  const pendingCreatePassed =
    !createOutcome.error && createOutcome.value.finalResult === null;
  recordProbe(
    "pending adjudication at create leaves immutable final metadata empty",
    "create succeeds with finalResult null",
    describe(createOutcome, (response) => `finalResult ${JSON.stringify(response.finalResult)}`),
    pendingCreatePassed,
  );

  const pendingUpdate = {
    kind: "pending-adjudication",
    reason: "timeout",
    eventId: "pending:timeout",
    eventAtMs: 1790000000100,
    activeClockDeadlineMs: null,
  };
  const pendingCheckpoint = checkpoint(gameId, 10, 1, pendingUpdate);
  const pendingBatch = archiveBatch({
    gameId,
    baseRevision: 8,
    baseOwnershipEpoch: 1,
    checkpointRevision: 10,
  });
  const pendingCommitOutcome = await capture(() => commitGame(db, {
    gameId,
    expectedRevision: 8,
    expectedEpoch: 1,
    operationId: pendingUpdateOperation,
    checkpointDto: pendingCheckpoint,
    batch: pendingBatch,
  }));
  const pendingReadOutcome = await capture(() => readGame(db, gameId));
  const pendingUpdatePassed =
    !pendingCommitOutcome.error &&
    pendingCommitOutcome.value.revision === 10 &&
    !pendingReadOutcome.error &&
    pendingReadOutcome.value.finalResult === null &&
    pendingReadOutcome.value.checkpoint?.payload === pendingCheckpoint;
  recordProbe(
    "pending adjudication facts remain mutable without latching a final result",
    "revision 10 stores changed pending facts and finalResult stays null",
    pendingCommitOutcome.error
      ? sqlError(pendingCommitOutcome.error)
      : pendingReadOutcome.error
        ? sqlError(pendingReadOutcome.error)
        : `accepted revision ${pendingReadOutcome.value.acceptedRevision}, finalResult ${JSON.stringify(pendingReadOutcome.value.finalResult)}`,
    pendingUpdatePassed,
  );

  const finalResult = {
    kind: "final",
    winner: "draw",
    reason: "stalemate",
    eventId: "final:event",
    decidedAtMs: 1790000000300,
  };
  const finalCheckpoint = checkpoint(gameId, 14, 1, finalResult);
  const finalBatch = archiveBatch({
    gameId,
    baseRevision: 10,
    baseOwnershipEpoch: 1,
    checkpointRevision: 14,
  });
  const finalOutcome = await capture(() => commitGame(db, {
    gameId,
    expectedRevision: 10,
    expectedEpoch: 1,
    operationId: finalOperation,
    checkpointDto: finalCheckpoint,
    batch: finalBatch,
    finalResult: JSON.stringify(finalResult),
  }));
  const latchedFinal = finalOutcome.value?.finalResult;
  const finalPassed =
    !finalOutcome.error &&
    finalOutcome.value.revision === 14 &&
    Object.entries(finalResult).every(([key, value]) => latchedFinal?.[key] === value) &&
    Object.keys(latchedFinal ?? {}).length === Object.keys(finalResult).length;
  recordProbe(
    "actual final result latches only when checkpoint and final argument agree",
    "revision 14 accepted with the complete final result latched",
    describe(finalOutcome, (response) => `accepted revision ${response.revision}, finalResult ${JSON.stringify(response.finalResult)}`),
    finalPassed,
  );

  const equalCheckpoint = checkpoint(gameId, 16, 1, finalResult);
  const equalBatch = archiveBatch({
    gameId,
    baseRevision: 14,
    baseOwnershipEpoch: 1,
    checkpointRevision: 16,
  });
  const reorderedFinal = '{ "decidedAtMs" : 1790000000300, "eventId" : "final:event", "reason" : "stalemate", "winner" : "draw", "kind" : "final" }';
  const equalOutcome = await capture(() => commitGame(db, {
    gameId,
    expectedRevision: 14,
    expectedEpoch: 1,
    operationId: equalFinalOperation,
    checkpointDto: equalCheckpoint,
    batch: equalBatch,
    finalResult: reorderedFinal,
  }));
  const semanticEqualityPassed =
    !equalOutcome.error && equalOutcome.value.revision === 16;
  recordProbe(
    "final-result latch compares semantic JSON values",
    "equivalent final JSON with different key order and whitespace advances to revision 16",
    describe(equalOutcome, (response) => `accepted revision ${response.revision}`),
    semanticEqualityPassed,
  );

  const changedResult = { ...finalResult, winner: "white", reason: "timeout" };
  const changedCheckpoint = checkpoint(gameId, 18, 1, finalResult);
  const changedBatch = archiveBatch({
    gameId,
    baseRevision: 16,
    baseOwnershipEpoch: 1,
    checkpointRevision: 18,
  });
  const changedOutcome = await capture(() => commitGame(db, {
    gameId,
    expectedRevision: 16,
    expectedEpoch: 1,
    operationId: changedFinalOperation,
    checkpointDto: changedCheckpoint,
    batch: changedBatch,
    finalResult: JSON.stringify(changedResult),
  }));
  const changedFinalRejected =
    changedOutcome.error?.code === "55000" &&
    changedOutcome.error.message === "a final result cannot be changed";
  recordProbe(
    "changed final result still fails through the immutable-result guard",
    "SQLSTATE 55000, a final result cannot be changed",
    changedOutcome.error
      ? sqlError(changedOutcome.error)
      : `unexpectedly accepted revision ${changedOutcome.value.revision}`,
    changedFinalRejected,
  );

  const deleteOperation = "eeeeeeee-0000-4000-8000-000000000006";
  const deleteOutcome = await capture(async () => {
    const query = await db.query(
      "select public.cloud_delete_game($1::uuid,1,16,1,$2::uuid) as response",
      [gameId, deleteOperation],
    );
    return query.rows[0].response;
  });
  const readDeletedOperation = await capture(() => readOperation(db, gameId, equalFinalOperation));
  const tombstoneRead = await capture(() => readGame(db, gameId));
  const retryEqualFinal = await capture(() => commitGame(db, {
    gameId,
    expectedRevision: 14,
    expectedEpoch: 1,
    operationId: equalFinalOperation,
    checkpointDto: equalCheckpoint,
    batch: equalBatch,
    finalResult: reorderedFinal,
  }));
  const deletionReceiptsPassed =
    !deleteOutcome.error &&
    deleteOutcome.value.receiptOnly === true &&
    !readDeletedOperation.error &&
    readDeletedOperation.value.response?.receiptOnly === true &&
    !Object.hasOwn(readDeletedOperation.value.response, "finalResult") &&
    !tombstoneRead.error &&
    tombstoneRead.value.deleted === true &&
    tombstoneRead.value.receiptOnly === true &&
    !tombstoneRead.value.checkpoint &&
    tombstoneRead.value.archiveBatches?.length === 0 &&
    !retryEqualFinal.error &&
    retryEqualFinal.value.receiptOnly === true &&
    !Object.hasOwn(retryEqualFinal.value, "finalResult");
  recordProbe(
    "delete and matching operation retry expose payload-free receipts",
    "tombstone, operation lookup, and exact retry omit checkpoint, archive, and final result payload",
    deleteOutcome.error
      ? sqlError(deleteOutcome.error)
      : readDeletedOperation.error
        ? sqlError(readDeletedOperation.error)
        : tombstoneRead.error
          ? sqlError(tombstoneRead.error)
          : retryEqualFinal.error
            ? sqlError(retryEqualFinal.error)
            : `delete receipt ${deleteOutcome.value.receiptOnly}, operation receipt ${readDeletedOperation.value.response?.receiptOnly}, retry receipt ${retryEqualFinal.value.receiptOnly}, tombstone batches ${tombstoneRead.value.archiveBatches?.length}`,
    deletionReceiptsPassed,
  );
}

async function main() {
  const bundleBytes = await readFile(probeBundleUrl);
  assert.equal(sha256(bundleBytes), expectedPgtapBundleSha256, "pgTAP bundle checksum mismatch");

  const db = new PGlite({ extensions: { pgcrypto, pgtap } });
  let fixtureLines = [];
  let fixturePlan = "missing";
  let fixtureError;
  try {
    const version = (await db.query("select version() as version")).rows[0].version;
    log(`Database: ${version}`);
    log("Execution: PGlite embedded PostgreSQL; one local connection, no listener");

    await db.exec(`
      create role anon nologin noinherit;
      create role authenticated nologin noinherit;
      create role service_role nologin noinherit bypassrls;
      create schema auth;
      create schema extensions;
      create table auth.users (
        id uuid primary key,
        aud text,
        role text,
        email text unique
      );
      create function auth.uid()
      returns uuid
      language sql
      stable
      set search_path = pg_catalog
      as $$
        select coalesce(
          nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
          nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid
      $$;
      grant usage on schema public, auth, extensions to anon, authenticated, service_role;
      grant execute on function auth.uid() to anon, authenticated, service_role;
    `);

    const migration = await readFile(migrationUrl, "utf8");
    await db.exec(migration);
    await db.exec(`
      set search_path = public, extensions;
      create extension pgtap with schema extensions;
    `);

    const fixture = await readFile(fixtureUrl, "utf8");
    const fixtureAssertions = fixture.match(
      /select\s+(?:ok|is|throws_ok)\s*\(/gi,
    ) ?? [];
    assert.equal(
      fixtureAssertions.length,
      expectedFixtureAssertions,
      "source fixture assertion count changed",
    );

    try {
      const results = await db.exec(fixture);
      fixtureLines = assertionLines(results);
      fixturePlan = results
        .flatMap((result) => result.rows ?? [])
        .flatMap((row) => Object.values(row))
        .find((value) => typeof value === "string" && /^1\.\.\d+$/.test(value)) ?? "missing";
    } catch (error) {
      fixtureError = `${sqlError(error)}${sourcePosition(fixture, error.position)}`;
      try {
        await db.exec("rollback;");
      } catch (rollbackError) {
        fixtureError += `; rollback failed: ${sqlError(rollbackError)}`;
      }
    }

    log(
      `Unmodified source fixture: ${fixtureLines.length}/${expectedFixtureAssertions} pgTAP assertion outputs; plan ${fixturePlan}`,
    );
    for (const line of fixtureLines.filter((value) => value.startsWith("not ok "))) {
      log(`  ${line}`);
    }
    if (fixtureError) log(`  SQL execution error: ${fixtureError}`);

    await runPublicRpcProbes(db);
  } finally {
    await db.close();
  }

  const fixturePassed =
    fixtureLines.length === expectedFixtureAssertions &&
    fixturePlan === `1..${expectedFixtureAssertions}` &&
    fixtureLines.every((line) => line.startsWith("ok ")) &&
    fixtureError === undefined;
  const probeFailures = probeResults.filter((probe) => !probe.passed);
  log(
    `Summary: fixture ${fixturePassed ? "PASS" : "FAIL"}; direct public-RPC probes ${probeResults.length - probeFailures.length}/${probeResults.length} passed.`,
  );
  if (!fixturePassed || probeFailures.length > 0) process.exitCode = 1;
}

await main();
