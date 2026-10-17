package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/Kamkmgamer/kamkmchess/backend/storage"
)

type cloudArchiveBatch struct {
	Format                string            `json:"format"`
	SchemaVersion         int               `json:"schemaVersion"`
	GameID                string            `json:"gameId"`
	BaseRevision          *int64            `json:"baseRevision"`
	BaseOwnershipEpoch    int64             `json:"baseOwnershipEpoch"`
	CheckpointRevision    int64             `json:"checkpointRevision"`
	EventsAfterSequence   *int64            `json:"eventsAfterSequence"`
	EventsThroughSequence *int64            `json:"eventsThroughSequence"`
	ChunksAfterSequence   *int64            `json:"chunksAfterSequence"`
	ChunksThroughSequence *int64            `json:"chunksThroughSequence"`
	Events                []json.RawMessage `json:"events"`
	Chunks                []json.RawMessage `json:"chunks"`
}

func parseArchiveBatch(raw []byte, gameID string, expectedRevision, expectedEpoch int64, checkpointRaw []byte) ([]storage.ArchiveEvent, []storage.ArchiveChunk, error) {
	if !uniqueJSON(raw) {
		return nil, nil, errors.New("invalid archive batch")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 12 {
		return nil, nil, errors.New("invalid archive batch")
	}
	for _, name := range []string{"format", "schemaVersion", "gameId", "baseRevision", "baseOwnershipEpoch", "checkpointRevision", "eventsAfterSequence", "eventsThroughSequence", "chunksAfterSequence", "chunksThroughSequence", "events", "chunks"} {
		if _, ok := fields[name]; !ok {
			return nil, nil, errors.New("invalid archive batch")
		}
	}
	var batch cloudArchiveBatch
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&batch); err != nil {
		return nil, nil, errors.New("invalid archive batch")
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return nil, nil, errors.New("invalid archive batch")
	}
	if batch.Format != "kamkmchess.cloud-archive-batch" || batch.SchemaVersion != 1 || batch.GameID != gameID || batch.BaseRevision == nil || *batch.BaseRevision != expectedRevision || batch.BaseOwnershipEpoch != expectedEpoch || batch.CheckpointRevision <= 0 || batch.Events == nil || batch.Chunks == nil {
		return nil, nil, errors.New("invalid archive batch")
	}
	var checkpoint struct {
		Revision int64 `json:"revision"`
	}
	if json.Unmarshal(checkpointRaw, &checkpoint) != nil || checkpoint.Revision != batch.CheckpointRevision {
		return nil, nil, errors.New("invalid archive batch")
	}
	events := make([]storage.ArchiveEvent, 0, len(batch.Events))
	eventSequences := make([]int64, 0, len(batch.Events))
	for _, item := range batch.Events {
		var record struct {
			Sequence int64 `json:"sequence"`
		}
		if !json.Valid(item) || json.Unmarshal(item, &record) != nil || record.Sequence < 0 {
			return nil, nil, errors.New("invalid archive event")
		}
		events = append(events, storage.ArchiveEvent{Sequence: record.Sequence, RawJSON: append([]byte(nil), item...)})
		eventSequences = append(eventSequences, record.Sequence)
	}
	chunks := make([]storage.ArchiveChunk, 0, len(batch.Chunks))
	chunkSequences := make([]int64, 0, len(batch.Chunks))
	for _, item := range batch.Chunks {
		var record struct {
			Sequence int64 `json:"sequence"`
		}
		if !json.Valid(item) || json.Unmarshal(item, &record) != nil || record.Sequence < 0 {
			return nil, nil, errors.New("invalid archive chunk")
		}
		sum := sha256.Sum256(item)
		chunks = append(chunks, storage.ArchiveChunk{Sequence: record.Sequence, RawJSON: append([]byte(nil), item...), SHA256: hex.EncodeToString(sum[:])})
		chunkSequences = append(chunkSequences, record.Sequence)
	}
	if !validSequenceRange(eventSequences, batch.EventsAfterSequence, batch.EventsThroughSequence) || !validSequenceRange(chunkSequences, batch.ChunksAfterSequence, batch.ChunksThroughSequence) {
		return nil, nil, errors.New("invalid archive sequence range")
	}
	return events, chunks, nil
}

func validSequenceRange(sequences []int64, after, through *int64) bool {
	if (after != nil && *after < 0) || (through != nil && *through < 0) {
		return false
	}
	if len(sequences) == 0 {
		return equalInt64(after, through)
	}
	if through == nil || sequences[len(sequences)-1] != *through {
		return false
	}
	for i, sequence := range sequences {
		if i > 0 && sequence <= sequences[i-1] {
			return false
		}
		if after != nil && sequence <= *after {
			return false
		}
	}
	return true
}

func equalInt64(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
