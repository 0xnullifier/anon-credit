-- Gateway state. One gateway process owns this database.
-- IDs, keys, and digests are canonical lowercase hex text ("0x" and 64 digits).
-- Integers are SQLite INTEGER (signed 64-bit). The gateway checks the range of each value.

-- One row per opened batch. The row is the spent marker of the batch: the gateway keeps it
-- through deadline_epoch + 1, so that a batch cannot open twice.
CREATE TABLE sessions (
    batch_id            TEXT    PRIMARY KEY NOT NULL CHECK (length(batch_id) = 66),
    session_pub         TEXT    NOT NULL CHECK (length(session_pub) = 66),
    remaining           INTEGER NOT NULL CHECK (remaining >= 0),
    units_total         INTEGER NOT NULL CHECK (units_total >= 0),
    next_seq            INTEGER NOT NULL CHECK (next_seq >= 0),
    open_epoch          INTEGER NOT NULL CHECK (open_epoch >= 0),
    deadline_epoch      INTEGER NOT NULL CHECK (deadline_epoch >= open_epoch),
    -- keccak256 of the open signing message. An exact retry has the same digest.
    open_request_digest TEXT    NOT NULL CHECK (length(open_request_digest) = 66),
    -- The open request without the proof bytes; proof_keccak256 replaces them.
    open_request_json   TEXT    NOT NULL,
    price_table_hash    TEXT    NOT NULL CHECK (length(price_table_hash) = 66),
    proof_size          INTEGER NOT NULL CHECK (proof_size >= 0),
    verify_ms           INTEGER NOT NULL CHECK (verify_ms >= 0),
    state               TEXT    NOT NULL CHECK (state IN ('active', 'exhausted')),
    opened_at           INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_by_opened_at ON sessions (opened_at);
CREATE INDEX sessions_by_deadline ON sessions (deadline_epoch);

-- One row per committed debit. response_bytes is set to NULL after the retention time.
CREATE TABLE receipts (
    batch_id       TEXT    NOT NULL REFERENCES sessions (batch_id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL CHECK (seq >= 0),
    request_digest TEXT    NOT NULL CHECK (length(request_digest) = 66),
    method         TEXT    NOT NULL,
    units          INTEGER NOT NULL CHECK (units > 0),
    units_total    INTEGER NOT NULL CHECK (units_total > 0),
    response_bytes BLOB,
    committed_at   INTEGER NOT NULL,
    PRIMARY KEY (batch_id, seq)
) STRICT;

CREATE INDEX receipts_with_response ON receipts (committed_at) WHERE response_bytes IS NOT NULL;

-- Cache of finalized roots from RootRegistry. The contract is the source of truth.
CREATE TABLE roots (
    source_epoch INTEGER PRIMARY KEY NOT NULL CHECK (source_epoch >= 0),
    root         TEXT    NOT NULL CHECK (length(root) = 66),
    leaf_count   INTEGER NOT NULL CHECK (leaf_count >= 0),
    fetched_at   INTEGER NOT NULL
) STRICT;
