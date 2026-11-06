//! ProveKit verifier adapter.
//!
//! Phase 1 adds these parts here:
//!
//! - A pinned ProveKit verifier for the native Spartan/WHIR proof, with hiding mode.
//! - Public-input construction from gateway values. Do not read public inputs from the request.
//! - A native benchmark command for verification time.
//!
//! Do not add a Groth16 wrapper. Do not add a remote prover.
