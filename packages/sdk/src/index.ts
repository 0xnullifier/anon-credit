// Client SDK.
//
// Phase 4 adds these parts here:
// - Purchase coordination: make batch secrets and commitments, track issuance.
// - Batch storage in encrypted IndexedDB, with a local unlock passphrase.
// - A request journal: persist signed request bytes before transmission.
// - Sessions: open with a proof, then signed RPC fetch with sequence numbers.
//
// The SDK sends only the required protocol headers to the gateway.
// It never sends payer identity, cookies, or purchase correlation IDs.

export { PROTOCOL_VERSION } from "@anon-credit/protocol";
