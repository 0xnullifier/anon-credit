//! JSON-RPC request allowlist and upstream response checks (implementation.md section 12).
//!
//! Request rules:
//!
//! - The request is one JSON object with duplicate-key rejection. Arrays (batch requests)
//!   are rejected.
//! - The keys are `jsonrpc` (`"2.0"`), `id`, `method`, and optional `params`. No other key
//!   is allowed.
//! - `id` is an integer or a string of at most [`MAX_ID_LEN`] bytes. A request without an
//!   `id` or with a `null` `id` is a notification and is rejected.
//! - The method must be in the price table and have a parameter rule here:
//!   `eth_chainId` and `eth_blockNumber` have no parameters (absent or `[]`);
//!   `eth_getBalance` has `[address, block]`.
//!
//! Upstream response rules: HTTP 200, one JSON object with `jsonrpc` `"2.0"`, the same `id`,
//! and exactly one of `result` or `error`. An `error` object has an integer `code` and a
//! string `message`. A response that obeys these rules is a completed call and is charged,
//! also if it is a JSON-RPC error.

use crate::strict_json::parse_strict;
use anon_credit_protocol::PriceTable;
use serde_json::{Map, Value};

/// Longest string `id` of a JSON-RPC request.
pub const MAX_ID_LEN: usize = 128;

/// Block tags that `eth_getBalance` accepts.
pub const BLOCK_TAGS: [&str; 5] = ["latest", "earliest", "pending", "safe", "finalized"];

/// A request that passed the allowlist.
#[derive(Debug, Clone, PartialEq)]
pub struct AllowedCall {
    /// JSON-RPC method name.
    pub method: String,
    /// Request `id`. The upstream response must have the same `id`.
    pub id: Value,
    /// Units of the method from the price table.
    pub units: u32,
}

/// Reason to reject a JSON-RPC request.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RpcRejection {
    /// The request does not obey the JSON-RPC rules. Error code `invalid_request`.
    #[error("{0}")]
    Invalid(&'static str),
    /// The method is not in the allowlist. Error code `method_not_allowed`.
    #[error("method is not allowed")]
    MethodNotAllowed,
}

/// Check one JSON-RPC request against the allowlist and the price table.
pub fn check_request(bytes: &[u8], prices: &PriceTable) -> Result<AllowedCall, RpcRejection> {
    let value = parse_strict(bytes).map_err(|_| RpcRejection::Invalid("rpc is not valid JSON"))?;
    let object = match value {
        Value::Object(object) => object,
        Value::Array(_) => return Err(RpcRejection::Invalid("batch requests are not supported")),
        _ => return Err(RpcRejection::Invalid("rpc must be a JSON object")),
    };
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "jsonrpc" | "id" | "method" | "params"))
    {
        return Err(RpcRejection::Invalid("rpc has an unknown member"));
    }
    if object.get("jsonrpc") != Some(&Value::String("2.0".to_owned())) {
        return Err(RpcRejection::Invalid("jsonrpc must be \"2.0\""));
    }
    let id = check_id(object.get("id"))?;
    let method = match object.get("method") {
        Some(Value::String(method)) => method.clone(),
        _ => return Err(RpcRejection::Invalid("method must be a string")),
    };
    let units = prices
        .units_of(&method)
        .ok_or(RpcRejection::MethodNotAllowed)?;
    check_params(&method, object.get("params"))?;
    Ok(AllowedCall { method, id, units })
}

fn check_id(id: Option<&Value>) -> Result<Value, RpcRejection> {
    match id {
        None | Some(Value::Null) => Err(RpcRejection::Invalid("notifications are not supported")),
        Some(Value::Number(n)) if n.is_i64() || n.is_u64() => Ok(Value::Number(n.clone())),
        Some(Value::String(text)) if text.len() <= MAX_ID_LEN => Ok(Value::String(text.clone())),
        Some(_) => Err(RpcRejection::Invalid(
            "id must be an integer or a short string",
        )),
    }
}

fn check_params(method: &str, params: Option<&Value>) -> Result<(), RpcRejection> {
    let empty = Vec::new();
    let list = match params {
        None => &empty,
        Some(Value::Array(list)) => list,
        Some(_) => return Err(RpcRejection::Invalid("params must be an array")),
    };
    match method {
        "eth_chainId" | "eth_blockNumber" => match list.is_empty() {
            true => Ok(()),
            false => Err(RpcRejection::Invalid("method takes no params")),
        },
        "eth_getBalance" => match list.as_slice() {
            [Value::String(address), Value::String(block)]
                if is_address(address) && is_block_selector(block) =>
            {
                Ok(())
            }
            _ => Err(RpcRejection::Invalid(
                "eth_getBalance params must be [address, block]",
            )),
        },
        // A method in the price table without a parameter rule is not allowed.
        _ => Err(RpcRejection::MethodNotAllowed),
    }
}

/// Tell if the text is `0x` and 40 hex digits (either case).
pub fn is_address(text: &str) -> bool {
    text.strip_prefix("0x")
        .is_some_and(|digits| digits.len() == 40 && digits.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Tell if the text is a block tag or a canonical hex block number of at most 64 bits.
pub fn is_block_selector(text: &str) -> bool {
    if BLOCK_TAGS.contains(&text) {
        return true;
    }
    match text.strip_prefix("0x").map(str::as_bytes) {
        Some([b'0']) => true,
        Some(digits @ [first, ..]) => {
            digits.len() <= 16
                && *first != b'0'
                && digits
                    .iter()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        }
        _ => false,
    }
}

/// Reason why an upstream response is not a completed JSON-RPC call.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UpstreamResponseError {
    /// The HTTP status is not 200.
    #[error("upstream HTTP status {0}")]
    Status(u16),
    /// The body is not a valid JSON-RPC response to the request.
    #[error("upstream response is not a valid JSON-RPC response: {0}")]
    Malformed(&'static str),
}

/// Check that an upstream response is a completed JSON-RPC call for request `id`.
pub fn check_response(status: u16, body: &[u8], id: &Value) -> Result<(), UpstreamResponseError> {
    if status != 200 {
        return Err(UpstreamResponseError::Status(status));
    }
    let object = match parse_strict(body) {
        Ok(Value::Object(object)) => object,
        Ok(_) => return Err(UpstreamResponseError::Malformed("not an object")),
        Err(_) => return Err(UpstreamResponseError::Malformed("not JSON")),
    };
    if object.get("jsonrpc") != Some(&Value::String("2.0".to_owned())) {
        return Err(UpstreamResponseError::Malformed("jsonrpc is not 2.0"));
    }
    if object.get("id") != Some(id) {
        return Err(UpstreamResponseError::Malformed("id does not match"));
    }
    match (object.get("result"), object.get("error")) {
        (Some(_), None) => Ok(()),
        (None, Some(Value::Object(error))) => check_error_object(error),
        _ => Err(UpstreamResponseError::Malformed(
            "response needs exactly one of result or error",
        )),
    }
}

fn check_error_object(error: &Map<String, Value>) -> Result<(), UpstreamResponseError> {
    let code_ok = error
        .get("code")
        .is_some_and(|code| code.is_i64() || code.is_u64());
    let message_ok = matches!(error.get("message"), Some(Value::String(_)));
    match code_ok && message_ok {
        true => Ok(()),
        false => Err(UpstreamResponseError::Malformed(
            "error needs an integer code and a string message",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(text: &str) -> Result<AllowedCall, RpcRejection> {
        check_request(text.as_bytes(), &PriceTable::initial())
    }

    #[test]
    fn allows_the_three_methods_with_their_units() {
        let call = check(r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}"#).unwrap();
        assert_eq!((call.method.as_str(), call.units), ("eth_chainId", 1));
        let call = check(r#"{"jsonrpc":"2.0","id":"a","method":"eth_blockNumber"}"#).unwrap();
        assert_eq!(call.units, 1);
        assert_eq!(call.id, Value::from("a"));
        let call = check(
            r#"{"jsonrpc":"2.0","id":2,"method":"eth_getBalance","params":["0x00000000219ab540356cBB839Cbe05303d7705Fa","latest"]}"#,
        )
        .unwrap();
        assert_eq!(call.units, 2);
        assert!(check(
            r#"{"jsonrpc":"2.0","id":2,"method":"eth_getBalance","params":["0x00000000219ab540356cbb839cbe05303d7705fa","0x1b4"]}"#
        )
        .is_ok());
    }

    #[test]
    fn rejects_other_methods() {
        assert_eq!(
            check(r#"{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[]}"#),
            Err(RpcRejection::MethodNotAllowed)
        );
        assert_eq!(
            check(r#"{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x"]}"#),
            Err(RpcRejection::MethodNotAllowed)
        );
    }

    #[test]
    fn rejects_bad_structure() {
        let bad = [
            r#"[{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}]"#,
            r#"{"jsonrpc":"2.0","method":"eth_chainId"}"#,
            r#"{"jsonrpc":"2.0","id":null,"method":"eth_chainId"}"#,
            r#"{"jsonrpc":"2.0","id":1.5,"method":"eth_chainId"}"#,
            r#"{"jsonrpc":"1.0","id":1,"method":"eth_chainId"}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","extra":1}"#,
            r#"{"jsonrpc":"2.0","id":1,"id":2,"method":"eth_chainId"}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[1]}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x00000000219ab540356cbb839cbe05303d7705fa"]}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x00","latest"]}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x00000000219ab540356cbb839cbe05303d7705fa","0x01"]}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x00000000219ab540356cbb839cbe05303d7705fa","newest"]}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x00000000219ab540356cbb839cbe05303d7705fa","latest",1]}"#,
        ];
        for text in bad {
            assert!(
                matches!(check(text), Err(RpcRejection::Invalid(_))),
                "{text}"
            );
        }
    }

    #[test]
    fn block_selector_rules() {
        assert!(is_block_selector("0x0"));
        assert!(is_block_selector("0xffffffffffffffff"));
        assert!(!is_block_selector("0x10000000000000000"));
        assert!(!is_block_selector("0x"));
        assert!(!is_block_selector("0xAB"));
        assert!(is_block_selector("safe"));
    }

    #[test]
    fn response_checks_charge_result_and_error_objects() {
        let id = Value::from(7);
        assert_eq!(
            check_response(200, br#"{"jsonrpc":"2.0","id":7,"result":"0x1"}"#, &id),
            Ok(())
        );
        assert_eq!(
            check_response(
                200,
                br#"{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"x"}}"#,
                &id
            ),
            Ok(())
        );
        assert_eq!(
            check_response(502, br#"{"jsonrpc":"2.0","id":7,"result":"0x1"}"#, &id),
            Err(UpstreamResponseError::Status(502))
        );
        let malformed: [&[u8]; 6] = [
            b"not json",
            br#"{"jsonrpc":"2.0","id":8,"result":"0x1"}"#,
            br#"{"jsonrpc":"2.0","id":7}"#,
            br#"{"jsonrpc":"2.0","id":7,"result":1,"error":{"code":1,"message":"x"}}"#,
            br#"{"jsonrpc":"2.0","id":7,"error":{"code":"x","message":"x"}}"#,
            br#"[{"jsonrpc":"2.0","id":7,"result":"0x1"}]"#,
        ];
        for body in malformed {
            assert!(matches!(
                check_response(200, body, &id),
                Err(UpstreamResponseError::Malformed(_))
            ));
        }
    }
}
