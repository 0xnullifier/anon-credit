//! `POST /v1/open` (implementation.md section 11, Architecture.md section 5.1).
//!
//! The rule: verify everything, then write, then serve. The order of the checks:
//!
//! 1. Body limit (16 MiB by default) and the envelope schema.
//! 2. Protocol version, deployment ID, and gateway ID.
//! 3. `batch_id` and `root` are canonical field elements.
//! 4. If a session with the batch ID exists: the open signature must verify. The same key and
//!    the same signed message is an exact retry and returns the existing state (also after
//!    the proof epoch aged out). Any other request is `session_conflict`.
//! 5. The price table hash equals the current table.
//! 6. The proof epoch is the current or the previous epoch.
//! 7. The root is accepted (last 96 source epochs) and the leaf count agrees.
//! 8. The open signature verifies.
//! 9. The proof verifies against public inputs that the gateway builds itself. At most two
//!    verifications run at the same time; a full queue gives `busy`.
//! 10. Insert the session. A unique batch ID makes a concurrent second insert fail.

use crate::app::{SharedGateway, read_body};
use crate::epoch::{proof_epoch_is_fresh, session_deadline};
use crate::error::ApiError;
use crate::events::EventDraft;
use crate::peer::Observed;
use crate::store::{InsertOutcome, SessionRow, StoredState};
use anon_credit_crypto::{
    BatchOpenPublicInputs, FieldElement, PUBLIC_INPUT_COUNT, keccak256, verify_ed25519,
};
use anon_credit_protocol::admin::EventKind;
use anon_credit_protocol::api::{OpenRequest, OpenResponse};
use anon_credit_protocol::{Bytes32, ErrorCode, PROTOCOL_VERSION};
use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;
use std::time::Instant;

/// `POST /v1/open`.
pub async fn open(
    State(gateway): State<SharedGateway>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let started = Instant::now();
    let observed = gateway.peer.observe(peer, &headers);
    let mut received = EventDraft::new(EventKind::OpenReceived, &observed);
    if let Ok(bytes) = &body {
        received = received.request_bytes(bytes.len());
    }
    gateway.events.publish(received);
    let mut batch_id = None;
    match open_inner(&gateway, &observed, body, started, &mut batch_id).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => {
            let mut draft = EventDraft::new(EventKind::OpenRejected, &observed)
                .error(error.code())
                .latency(started);
            if let Some(batch_id) = batch_id {
                draft = draft.batch(batch_id);
            }
            gateway.events.publish(draft);
            error.into_response()
        }
    }
}

/// Build the batch-open public inputs in circuit order:
/// `[circuit_id, deployment_id[hi, lo], gateway_id[hi, lo], root, leaf_count, proof_epoch,
/// batch_id, binding]`, with `binding = H(DOM_BINDING, gateway_id limbs, session_pub limbs)`.
///
/// The gateway takes the IDs from its configuration, the root and the leaf count from the
/// accepted root record, and only the proof epoch, the batch ID, and the session key from the
/// request. `fixtures/protocol/batch-open-public-inputs.json` pins this order.
pub fn build_public_inputs(
    deployment_id: &Bytes32,
    gateway_id: &Bytes32,
    root: FieldElement,
    leaf_count: u32,
    proof_epoch: u64,
    batch_id: FieldElement,
    session_pub: &Bytes32,
) -> [FieldElement; PUBLIC_INPUT_COUNT] {
    BatchOpenPublicInputs::for_open(
        deployment_id.0,
        gateway_id.0,
        root,
        leaf_count,
        proof_epoch,
        batch_id,
        &session_pub.0,
    )
    .to_fields()
}

fn invalid(message: &str) -> ApiError {
    ApiError::new(ErrorCode::InvalidRequest, message)
}

fn check_signature(request: &OpenRequest) -> Result<(), ApiError> {
    let digest = request.message().digest();
    verify_ed25519(&request.session_pub.0, &digest.0, &request.signature.0).map_err(|_| {
        ApiError::new(
            ErrorCode::SignatureInvalid,
            "open signature does not verify",
        )
    })
}

/// The open request without the proof bytes, for the session row.
fn stored_request_json(request: &OpenRequest) -> Result<String, ApiError> {
    let mut value = serde_json::to_value(request).map_err(|_| ApiError::storage())?;
    if let Some(object) = value.as_object_mut() {
        object.remove("proof");
        object.insert(
            "proof_keccak256".to_owned(),
            serde_json::Value::String(Bytes32(keccak256(&request.proof.0)).to_hex()),
        );
    }
    serde_json::to_string(&value).map_err(|_| ApiError::storage())
}

/// Answer an open request for a batch ID that already has a session.
fn existing_session(
    gateway: &SharedGateway,
    request: &OpenRequest,
    row: &SessionRow,
    observed: &Observed,
) -> Result<OpenResponse, ApiError> {
    check_signature(request)?;
    let exact = row.session_pub == request.session_pub
        && row.open_request_digest == request.message().digest();
    if !exact {
        return Err(ApiError::new(
            ErrorCode::SessionConflict,
            "batch is already open with a different open request",
        ));
    }
    let current = gateway.current_epoch();
    gateway.events.publish(
        EventDraft::new(EventKind::SessionOpened, observed)
            .batch(row.batch_id)
            .remaining(row.remaining),
    );
    Ok(OpenResponse {
        session: gateway.session_state(row, current),
        existing: true,
    })
}

async fn open_inner(
    gateway: &SharedGateway,
    observed: &Observed,
    body: Result<Bytes, BytesRejection>,
    started: Instant,
    batch_id: &mut Option<Bytes32>,
) -> Result<OpenResponse, ApiError> {
    let body = read_body(body)?;
    let request: OpenRequest = serde_json::from_slice(&body)
        .map_err(|_| invalid("open request does not match the schema"))?;
    *batch_id = Some(request.batch_id);
    let config = &gateway.config;

    if request.protocol_version != PROTOCOL_VERSION {
        return Err(ApiError::new(
            ErrorCode::UnsupportedVersion,
            "protocol version is not supported",
        ));
    }
    if request.deployment_id != config.deployment_id {
        return Err(invalid("deployment_id is not the gateway deployment"));
    }
    if request.gateway_id != config.gateway_id() {
        return Err(invalid("gateway_id is not this gateway"));
    }
    let batch_field = FieldElement::from_bytes_be(&request.batch_id.0)
        .map_err(|_| invalid("batch_id is not a canonical field element"))?;
    let root_field = FieldElement::from_bytes_be(&request.root.0)
        .map_err(|_| invalid("root is not a canonical field element"))?;

    let existing = gateway
        .store
        .session(&request.batch_id)
        .await
        .map_err(|_| ApiError::storage())?;
    if let Some(row) = existing {
        return existing_session(gateway, &request, &row, observed);
    }

    if request.price_table_hash != config.price_table_hash {
        return Err(invalid("price_table_hash is not the current price table"));
    }
    let current = gateway.current_epoch();
    let proof_epoch = request.proof_epoch.0;
    if !proof_epoch_is_fresh(proof_epoch, current) {
        return Err(ApiError::new(
            ErrorCode::ProofEpochStale,
            "proof epoch is not the current or the previous epoch",
        ));
    }
    let record = gateway
        .roots
        .find(&request.root, current)
        .ok_or_else(|| ApiError::new(ErrorCode::RootNotAccepted, "root is not accepted"))?;
    if record.leaf_count != request.leaf_count {
        return Err(ApiError::new(
            ErrorCode::RootNotAccepted,
            "leaf_count does not match the accepted root",
        ));
    }
    check_signature(&request)?;
    let deadline_epoch =
        session_deadline(current).ok_or_else(|| invalid("epoch is out of range"))?;

    // The gateway builds the public inputs. The request has no public-input field.
    let inputs = build_public_inputs(
        &config.deployment_id,
        &config.gateway_id(),
        root_field,
        record.leaf_count,
        proof_epoch,
        batch_field,
        &request.session_pub,
    );
    let outcome = {
        let _slot = gateway
            .verify_queue
            .enter()
            .await
            .map_err(|_| ApiError::new(ErrorCode::Busy, "proof verification queue is full"))?;
        gateway
            .verifier
            .verify(&request.proof.0, &inputs)
            .await
            .map_err(|_| ApiError::new(ErrorCode::Busy, "proof verifier is not available"))?
    };
    if !outcome.ok {
        return Err(ApiError::new(
            ErrorCode::ProofInvalid,
            "proof does not verify",
        ));
    }
    gateway.events.publish(
        EventDraft::new(EventKind::OpenVerified, observed)
            .batch(request.batch_id)
            .latency_ms(outcome.duration_ms)
            .response_bytes(request.proof.0.len()),
    );

    let row = SessionRow {
        batch_id: request.batch_id,
        session_pub: request.session_pub,
        remaining: config.deployment.batch_size,
        units_total: 0,
        next_seq: 0,
        open_epoch: current,
        deadline_epoch,
        open_request_digest: request.message().digest(),
        open_request_json: stored_request_json(&request)?,
        price_table_hash: request.price_table_hash,
        proof_size: u32::try_from(request.proof.0.len()).unwrap_or(u32::MAX),
        verify_ms: u32::try_from(outcome.duration_ms).unwrap_or(u32::MAX),
        state: StoredState::for_remaining(config.deployment.batch_size),
        opened_at: gateway.clock.now_unix(),
    };
    let inserted = gateway
        .store
        .insert_session(&row)
        .await
        .map_err(|_| ApiError::storage())?;
    match inserted {
        InsertOutcome::Inserted => {
            gateway.events.publish(
                EventDraft::new(EventKind::SessionOpened, observed)
                    .batch(row.batch_id)
                    .units(0, row.remaining)
                    .latency(started),
            );
            Ok(OpenResponse {
                session: gateway.session_state(&row, current),
                existing: false,
            })
        }
        InsertOutcome::AlreadyExists => {
            // A concurrent open of the same batch committed first.
            let stored = gateway
                .store
                .session(&request.batch_id)
                .await
                .map_err(|_| ApiError::storage())?
                .ok_or_else(ApiError::storage)?;
            existing_session(gateway, &request, &stored, observed)
        }
    }
}
