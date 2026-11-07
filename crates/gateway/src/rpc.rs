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
//!   `eth_getBalance` has `[address, block]`;
//!   `eth_getTransactionReceipt` has `[hash]` (`0x` and 64 hex digits);
//!   `eth_call` has `[call, block]`. See [`check_call_object`] for the call object.
//! - A block is a tag in [`BLOCK_TAGS`] or a canonical hex block number of at most 64 bits.
//!
//! `eth_call` can give a large response. The gateway does not limit the response here: the
//! upstream client stops a response above `GATEWAY_UPSTREAM_RESPONSE_LIMIT_BYTES`, and the
//! spend gives `upstream_failed` with no charge.
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

/// Block tags that `eth_getBalance` and `eth_call` accept.
pub const BLOCK_TAGS: [&str; 5] = ["latest", "earliest", "pending", "safe", "finalized"];

/// Largest `data` (or `input`) of an `eth_call` call object, in bytes (8 KiB).
pub const MAX_CALL_DATA_BYTES: usize = 8 * 1024;

/// Members that an `eth_call` call object can have.
pub const CALL_OBJECT_KEYS: [&str; 7] = ["from", "to", "data", "input", "value", "gas", "gasPrice"];

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
        "eth_getTransactionReceipt" => match list.as_slice() {
            [Value::String(hash)] if is_hash32(hash) => Ok(()),
            _ => Err(RpcRejection::Invalid(
                "eth_getTransactionReceipt params must be [transaction hash]",
            )),
        },
        "eth_call" => match list.as_slice() {
            [Value::Object(call), Value::String(block)] if is_block_selector(block) => {
                check_call_object(call)
            }
            _ => Err(RpcRejection::Invalid(
                "eth_call params must be [call object, block]",
            )),
        },
        // A method in the price table without a parameter rule is not allowed.
        _ => Err(RpcRejection::MethodNotAllowed),
    }
}

/// Check the call object of `eth_call`.
///
/// - `to` (address) is necessary. `from` (address) is optional.
/// - `data` or `input` (hex bytes, at most [`MAX_CALL_DATA_BYTES`]) is optional. A call object
///   with the two members is rejected.
/// - `value` and `gasPrice` (hex quantities of at most 256 bits) and `gas` (hex quantity of at
///   most 64 bits) are optional.
/// - Each value is a string. Other members are rejected.
pub fn check_call_object(call: &Map<String, Value>) -> Result<(), RpcRejection> {
    for (key, value) in call {
        let Value::String(text) = value else {
            return Err(RpcRejection::Invalid(
                "eth_call object members must be strings",
            ));
        };
        let (valid, message) = match key.as_str() {
            "from" | "to" => (is_address(text), "eth_call from and to must be addresses"),
            "data" | "input" => (
                is_hex_bytes(text, MAX_CALL_DATA_BYTES),
                "eth_call data must be hex bytes of at most 8192 bytes",
            ),
            "value" | "gasPrice" => (
                is_quantity(text, 64),
                "eth_call value and gasPrice must be hex quantities of at most 256 bits",
            ),
            "gas" => (
                is_quantity(text, 16),
                "eth_call gas must be a hex quantity of at most 64 bits",
            ),
            _ => {
                return Err(RpcRejection::Invalid(
                    "eth_call object has an unknown member",
                ));
            }
        };
        if !valid {
            return Err(RpcRejection::Invalid(message));
        }
    }
    if !call.contains_key("to") {
        return Err(RpcRejection::Invalid("eth_call object needs to"));
    }
    if call.contains_key("data") && call.contains_key("input") {
        return Err(RpcRejection::Invalid(
            "eth_call object can have data or input, not both",
        ));
    }
    Ok(())
}

/// Tell if the text is `0x` and 40 hex digits (either case).
pub fn is_address(text: &str) -> bool {
    has_hex_digits(text, 40)
}

/// Tell if the text is `0x` and 64 hex digits (either case).
pub fn is_hash32(text: &str) -> bool {
    has_hex_digits(text, 64)
}

fn has_hex_digits(text: &str, count: usize) -> bool {
    text.strip_prefix("0x").is_some_and(|digits| {
        digits.len() == count && digits.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

/// Tell if the text is `0x` and an even number of hex digits (either case) for at most
/// `max_bytes` bytes. `0x` alone is zero bytes.
pub fn is_hex_bytes(text: &str, max_bytes: usize) -> bool {
    text.strip_prefix("0x").is_some_and(|digits| {
        digits.len() % 2 == 0
            && digits.len() <= max_bytes * 2
            && digits.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

/// Tell if the text is a canonical hex quantity of at most `max_digits` digits: `0x0`, or
/// `0x` and lowercase digits with no leading zero.
pub fn is_quantity(text: &str, max_digits: usize) -> bool {
    match text.strip_prefix("0x").map(str::as_bytes) {
        Some([b'0']) => true,
        Some(digits @ [first, ..]) => {
            digits.len() <= max_digits
                && *first != b'0'
                && digits
                    .iter()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        }
        _ => false,
    }
}

/// Tell if the text is a block tag or a canonical hex block number of at most 64 bits.
pub fn is_block_selector(text: &str) -> bool {
    BLOCK_TAGS.contains(&text) || is_quantity(text, 16)
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
        check_request(text.as_bytes(), &PriceTable::current())
    }

    fn call(params: &str) -> Result<AllowedCall, RpcRejection> {
        check(&format!(
            r#"{{"jsonrpc":"2.0","id":3,"method":"eth_call","params":{params}}}"#
        ))
    }

    const TO: &str = "0x00000000219ab540356cbb839cbe05303d7705fa";

    #[test]
    fn allows_the_initial_methods_with_their_units() {
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
    fn allows_the_two_new_methods_with_their_units() {
        let call_ok = call(&format!(
            r#"[{{"to":"{TO}","data":"0x70a08231"}},"latest"]"#
        ))
        .unwrap();
        assert_eq!((call_ok.method.as_str(), call_ok.units), ("eth_call", 3));
        let receipt = check(
            r#"{"jsonrpc":"2.0","id":4,"method":"eth_getTransactionReceipt","params":["0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b"]}"#,
        )
        .unwrap();
        assert_eq!(
            (receipt.method.as_str(), receipt.units),
            ("eth_getTransactionReceipt", 2)
        );
        assert!(check(
            r#"{"jsonrpc":"2.0","id":4,"method":"eth_getTransactionReceipt","params":["0x88DF016429689C079F3B2F6AD39FA052532C56795B733DA78A91EBE6A713944B"]}"#
        )
        .is_ok());
    }

    #[test]
    fn eth_call_accepts_each_member_and_block() {
        let data = format!("0x{}", "ab".repeat(MAX_CALL_DATA_BYTES));
        let good = [
            format!(r#"[{{"to":"{TO}"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}"}},"0x1b4"]"#),
            format!(r#"[{{"to":"{TO}"}},"finalized"]"#),
            format!(r#"[{{"to":"{TO}","data":"0x"}},"pending"]"#),
            format!(r#"[{{"to":"{TO}","input":"0xABCDEF"}},"safe"]"#),
            format!(r#"[{{"to":"{TO}","data":"{data}"}},"latest"]"#),
            format!(
                r#"[{{"from":"0x000000000000000000000000000000000000dEaD","to":"{TO}","data":"0x00","value":"0x0","gas":"0xffffffffffffffff","gasPrice":"0x3b9aca00"}},"earliest"]"#
            ),
            format!(
                r#"[{{"to":"{TO}","value":"0x{}"}},"latest"]"#,
                "f".repeat(64)
            ),
        ];
        for params in good {
            assert_eq!(call(&params).map(|c| c.units), Ok(3), "{params}");
        }
    }

    #[test]
    fn eth_call_rejects_bad_params() {
        let long = format!("0x{}", "ab".repeat(MAX_CALL_DATA_BYTES + 1));
        let bad = [
            // Shape of params.
            "[]".to_owned(),
            format!(r#"[{{"to":"{TO}"}}]"#),
            format!(r#"[{{"to":"{TO}"}},"latest",1]"#),
            format!(r#"["{TO}","latest"]"#),
            format!(r#"[[{{"to":"{TO}"}}],"latest"]"#),
            // Block selector.
            format!(r#"[{{"to":"{TO}"}},"newest"]"#),
            format!(r#"[{{"to":"{TO}"}},"0x01"]"#),
            format!(r#"[{{"to":"{TO}"}},"0x10000000000000000"]"#),
            format!(r#"[{{"to":"{TO}"}},{{"blockHash":"0x00"}}]"#),
            format!(r#"[{{"to":"{TO}"}},null]"#),
            // Call object members.
            r#"[{},"latest"]"#.to_owned(),
            r#"[{"data":"0x00"},"latest"]"#.to_owned(),
            r#"[{"to":null},"latest"]"#.to_owned(),
            r#"[{"to":"0x00"},"latest"]"#.to_owned(),
            format!(r#"[{{"to":"{TO}","from":"0x1234"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","nonce":"0x1"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","accessList":[]}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","maxFeePerGas":"0x1"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","data":"0xabc"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","data":"abcd"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","data":"0xzz"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","data":"{long}"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","input":"{long}"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","data":"0x00","input":"0x00"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","value":"0x01"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","value":"0xA"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","value":"0x"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","value":1}},"latest"]"#),
            format!(
                r#"[{{"to":"{TO}","value":"0x1{}"}},"latest"]"#,
                "0".repeat(64)
            ),
            format!(r#"[{{"to":"{TO}","gas":"0x10000000000000000"}},"latest"]"#),
            format!(r#"[{{"to":"{TO}","gasPrice":"10"}},"latest"]"#),
        ];
        for params in bad {
            assert!(
                matches!(call(&params), Err(RpcRejection::Invalid(_))),
                "{params}"
            );
        }
        // Duplicate members of the call object are rejected by the strict parser.
        assert!(matches!(
            call(&format!(r#"[{{"to":"{TO}","to":"{TO}"}},"latest"]"#)),
            Err(RpcRejection::Invalid(_))
        ));
    }

    #[test]
    fn eth_get_transaction_receipt_rejects_bad_params() {
        let hash = "88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b";
        let bad = [
            "[]".to_owned(),
            format!(r#"["0x{hash}","latest"]"#),
            format!(r#"["{hash}"]"#),
            format!(r#"["0x{}"]"#, &hash[1..]),
            format!(r#"["0x{hash}00"]"#),
            format!(r#"["0x{}zz"]"#, &hash[2..]),
            format!(r#"[{{"hash":"0x{hash}"}}]"#),
            "[null]".to_owned(),
        ];
        for params in bad {
            let text = format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":{params}}}"#
            );
            assert!(
                matches!(check(&text), Err(RpcRejection::Invalid(_))),
                "{params}"
            );
        }
    }

    #[test]
    fn version_one_table_does_not_allow_the_new_methods() {
        let v1 = PriceTable::initial();
        let text = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{{"to":"{TO}"}},"latest"]}}"#
        );
        assert_eq!(
            check_request(text.as_bytes(), &v1),
            Err(RpcRejection::MethodNotAllowed)
        );
    }

    #[test]
    fn rejects_other_methods() {
        assert_eq!(
            check(r#"{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[]}"#),
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
