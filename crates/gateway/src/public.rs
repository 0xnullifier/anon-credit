//! Public read endpoints: configuration, prices, roots, and the demo peer probe.

use crate::app::{SESSION_LIFETIME_EPOCHS_U32, SharedGateway};
use crate::roots::WINDOW_EPOCHS_U32;
use anon_credit_crypto::constants::CIRCUIT_ID;
use anon_credit_protocol::api::{
    DemoPeerResponse, GatewayConfigResponse, PricesResponse, RootsResponse,
};
use anon_credit_protocol::{Bytes32, DecimalU64, PROTOCOL_VERSION};
use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use std::net::SocketAddr;

/// `GET /v1/config`.
pub async fn config(State(gateway): State<SharedGateway>) -> Json<GatewayConfigResponse> {
    let config = &gateway.config;
    let deployment = &config.deployment;
    Json(GatewayConfigResponse {
        protocol_version: PROTOCOL_VERSION,
        deployment_id: config.deployment_id,
        gateway_id: deployment.gateway_id,
        circuit_id: Bytes32(CIRCUIT_ID.to_bytes_be()),
        verifier_artifact_hash: deployment.verifier_artifact_hash,
        payment_chain_id: deployment.payment_chain_id,
        upstream_chain_id: config.upstream_chain_id,
        root_registry_address: deployment.root_registry_address,
        epoch_seconds: deployment.epoch_seconds,
        current_epoch: DecimalU64(gateway.current_epoch()),
        root_window_epochs: WINDOW_EPOCHS_U32,
        session_lifetime_epochs: SESSION_LIFETIME_EPOCHS_U32,
        batch_size: deployment.batch_size,
        price_table_hash: config.price_table_hash,
        limits: config.limits.to_api(),
        demo_peer_enabled: gateway.peer.captures(),
        block_tag: config.block_tag,
    })
}

/// `GET /v1/prices`.
pub async fn prices(State(gateway): State<SharedGateway>) -> Json<PricesResponse> {
    Json(PricesResponse {
        price_table_hash: gateway.config.price_table_hash,
        price_table: gateway.config.prices.clone(),
    })
}

/// `GET /v1/roots`.
pub async fn roots(State(gateway): State<SharedGateway>) -> Json<RootsResponse> {
    let current = gateway.current_epoch();
    Json(RootsResponse {
        current_epoch: DecimalU64(current),
        root_window_epochs: WINDOW_EPOCHS_U32,
        roots: gateway
            .roots
            .accepted(current)
            .iter()
            .map(|r| r.to_api())
            .collect(),
    })
}

/// `GET /v1/demo/peer`. The router has this route only when IP capture is on.
///
/// It takes no batch or purchase identifier and writes no event.
pub async fn demo_peer(
    State(gateway): State<SharedGateway>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Json<DemoPeerResponse> {
    let observed = gateway.peer.observe(peer, &headers);
    Json(DemoPeerResponse {
        observed_ip: observed.ip,
        attribution: observed.attribution,
        proxy_hop: observed.proxy_hop,
    })
}
