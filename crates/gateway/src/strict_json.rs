//! JSON parser that rejects duplicate object keys.
//!
//! `serde_json::Value` keeps the last value of a duplicate key. Two parsers can then read
//! different requests from the same bytes. The gateway forwards the exact client bytes
//! upstream, so it rejects duplicate keys at every depth before it reads the request.

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

/// Failure of a strict JSON parse.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("JSON is not valid: {0}")]
pub struct StrictJsonError(String);

/// Parse one JSON value. Reject duplicate keys, trailing data, and invalid UTF-8.
pub fn parse_strict(bytes: &[u8]) -> Result<Value, StrictJsonError> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value =
        StrictValue::deserialize(&mut deserializer).map_err(|e| StrictJsonError(e.to_string()))?;
    deserializer
        .end()
        .map_err(|e| StrictJsonError(e.to_string()))?;
    Ok(value.0)
}

struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = StrictValue;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Bool(v)))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(v.into())))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(v.into())))
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        Number::from_f64(v)
            .map(|n| StrictValue(Value::Number(n)))
            .ok_or_else(|| E::custom("number is not finite"))
    }

    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(v.to_owned())))
    }

    fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(v)))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut items = Vec::new();
        while let Some(StrictValue(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(StrictValue(Value::Array(items)))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut out = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if out.contains_key(&key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            let StrictValue(value) = map.next_value()?;
            out.insert(key, value);
        }
        Ok(StrictValue(Value::Object(out)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_values() {
        let value = parse_strict(br#"{"a":[1,-2,3.5,"x",null,true,{"b":{}}]}"#).unwrap();
        assert_eq!(value["a"][1], Value::from(-2));
        assert_eq!(value["a"][6]["b"], Value::Object(Map::new()));
    }

    #[test]
    fn rejects_duplicate_keys_at_any_depth() {
        assert!(parse_strict(br#"{"a":1,"a":2}"#).is_err());
        assert!(parse_strict(br#"{"x":[{"a":1,"a":1}]}"#).is_err());
        // Escapes give the same key text. That is a duplicate too.
        assert!(parse_strict(br#"{"a":1,"a":2}"#).is_err());
    }

    #[test]
    fn rejects_trailing_data_and_bad_utf8() {
        assert!(parse_strict(b"{} {}").is_err());
        assert!(parse_strict(b"{\"a\":\"\xff\"}").is_err());
        assert!(parse_strict(b"").is_err());
    }
}
