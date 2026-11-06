//! Upstream JSON-RPC client.
//!
//! [`Upstream`] sends the exact client RPC bytes to the configured node. [`HttpUpstream`] is
//! the real client: one POST with a total timeout and a cap on the response size. Tests use
//! a fake implementation.
//!
//! The upstream URL can contain an API key. Never log it.

use async_trait::async_trait;
use axum::body::Bytes;
use std::time::Duration;

/// HTTP response of the upstream node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamReply {
    /// HTTP status code.
    pub status: u16,
    /// Response body, at most the configured limit.
    pub body: Bytes,
}

/// Transport failure of an upstream call. The gateway does not charge units for it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UpstreamError {
    /// The connection failed or the request timed out.
    #[error("upstream transport failed: {0}")]
    Transport(String),
    /// The response is larger than the limit.
    #[error("upstream response is larger than {0} bytes")]
    TooLarge(usize),
}

/// A JSON-RPC upstream.
#[async_trait]
pub trait Upstream: Send + Sync + 'static {
    /// Send one JSON-RPC request body and read the response.
    async fn call(&self, body: Bytes) -> Result<UpstreamReply, UpstreamError>;
}

/// The real upstream: HTTP POST with `reqwest`.
#[derive(Debug, Clone)]
pub struct HttpUpstream {
    client: reqwest::Client,
    url: reqwest::Url,
    max_response_bytes: usize,
}

impl HttpUpstream {
    /// Make a client with a total request timeout and a response size limit.
    pub fn new(
        url: reqwest::Url,
        timeout: Duration,
        max_response_bytes: usize,
    ) -> Result<Self, UpstreamError> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| UpstreamError::Transport(safe_text(&e)))?;
        Ok(Self {
            client,
            url,
            max_response_bytes,
        })
    }
}

/// Text of a `reqwest` error without the URL. The URL can contain an API key.
fn safe_text(error: &reqwest::Error) -> String {
    let kind = match () {
        _ if error.is_timeout() => "timeout",
        _ if error.is_connect() => "connect",
        _ if error.is_body() || error.is_decode() => "body",
        _ if error.is_request() => "request",
        _ => "other",
    };
    format!("{kind} error")
}

#[async_trait]
impl Upstream for HttpUpstream {
    async fn call(&self, body: Bytes) -> Result<UpstreamReply, UpstreamError> {
        let mut response = self
            .client
            .post(self.url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| UpstreamError::Transport(safe_text(&e)))?;
        let status = response.status().as_u16();
        if response
            .content_length()
            .is_some_and(|len| len > self.max_response_bytes as u64)
        {
            return Err(UpstreamError::TooLarge(self.max_response_bytes));
        }
        let mut out = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| UpstreamError::Transport(safe_text(&e)))?
        {
            if out.len() + chunk.len() > self.max_response_bytes {
                return Err(UpstreamError::TooLarge(self.max_response_bytes));
            }
            out.extend_from_slice(&chunk);
        }
        Ok(UpstreamReply {
            status,
            body: Bytes::from(out),
        })
    }
}

/// Failure of the startup chain ID check.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChainIdError {
    /// The call failed.
    #[error(transparent)]
    Upstream(#[from] UpstreamError),
    /// The response is not a valid `eth_chainId` result.
    #[error("upstream eth_chainId response is not valid")]
    BadResponse,
}

/// Read the chain ID of an upstream with `eth_chainId`.
pub async fn read_chain_id(upstream: &dyn Upstream) -> Result<u64, ChainIdError> {
    let request =
        Bytes::from_static(br#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}"#);
    let reply = upstream.call(request).await?;
    let id = serde_json::Value::from(1);
    crate::rpc::check_response(reply.status, &reply.body, &id)
        .map_err(|_| ChainIdError::BadResponse)?;
    let value: serde_json::Value =
        serde_json::from_slice(&reply.body).map_err(|_| ChainIdError::BadResponse)?;
    let text = value
        .get("result")
        .and_then(serde_json::Value::as_str)
        .and_then(|text| text.strip_prefix("0x"))
        .ok_or(ChainIdError::BadResponse)?;
    u64::from_str_radix(text, 16).map_err(|_| ChainIdError::BadResponse)
}
