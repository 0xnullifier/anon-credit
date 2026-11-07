//! Price table and `price_table_hash`.
//!
//! Canonical encoding: compact JSON in UTF-8, with no white space, and with the object keys
//! in ascending byte order at each level:
//!
//! ```text
//! {"units":{"eth_blockNumber":1,"eth_call":3,"eth_chainId":1,"eth_getBalance":2,"eth_getTransactionReceipt":2},"version":2}
//! ```
//!
//! - `units` maps each allowed JSON-RPC method name to its units per request.
//! - A method name has 1 to 64 characters from `A-Z`, `a-z`, `0-9`, and `_`. Thus no name
//!   needs a JSON escape.
//! - Each unit value and the version are decimal integers from 1 to `2^32 - 1`.
//!
//! `price_table_hash = keccak256(canonical encoding)`. A session freezes the table hash at
//! open. A new table affects only new sessions.

use crate::hex_bytes::Bytes32;
use anon_credit_crypto::keccak256;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Version of the initial price table (three methods).
pub const INITIAL_PRICE_TABLE_VERSION: u32 = 1;

/// Version of the current price table (five methods). The gateway serves this table.
pub const PRICE_TABLE_VERSION: u32 = 2;

/// Longest method name in a price table.
pub const MAX_METHOD_NAME_LEN: usize = 64;

/// Failure of a price table check.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PriceTableError {
    /// The table has no methods.
    #[error("price table has no methods")]
    Empty,
    /// A method name is empty, too long, or has a character that is not allowed.
    #[error("method name is not valid: {0:?}")]
    BadMethodName(String),
    /// A unit value or the version is zero.
    #[error("price table value must be greater than zero")]
    ZeroValue,
}

/// A versioned table of units per JSON-RPC method.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PriceTable {
    /// Units per request for each allowed method. The map keeps the keys in byte order.
    pub units: BTreeMap<String, u32>,
    /// Version of the table.
    pub version: u32,
}

impl PriceTable {
    /// The initial table, version 1: `eth_chainId` 1, `eth_blockNumber` 1,
    /// `eth_getBalance` 2. The gateway does not serve it. It stays for the history of the
    /// hash.
    pub fn initial() -> Self {
        Self::from_entries(
            &[
                ("eth_chainId", 1),
                ("eth_blockNumber", 1),
                ("eth_getBalance", 2),
            ],
            INITIAL_PRICE_TABLE_VERSION,
        )
    }

    /// The current table, version 2: the initial methods at the same units, and
    /// `eth_call` 3 and `eth_getTransactionReceipt` 2.
    pub fn current() -> Self {
        Self::from_entries(
            &[
                ("eth_chainId", 1),
                ("eth_blockNumber", 1),
                ("eth_getBalance", 2),
                ("eth_call", 3),
                ("eth_getTransactionReceipt", 2),
            ],
            PRICE_TABLE_VERSION,
        )
    }

    fn from_entries(entries: &[(&str, u32)], version: u32) -> Self {
        let units = entries
            .iter()
            .map(|(method, units)| ((*method).to_owned(), *units))
            .collect();
        Self { units, version }
    }

    /// Check the method names and values.
    pub fn validate(&self) -> Result<(), PriceTableError> {
        if self.units.is_empty() {
            return Err(PriceTableError::Empty);
        }
        if self.version == 0 {
            return Err(PriceTableError::ZeroValue);
        }
        for (method, units) in &self.units {
            let name_ok = !method.is_empty()
                && method.len() <= MAX_METHOD_NAME_LEN
                && method
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_');
            if !name_ok {
                return Err(PriceTableError::BadMethodName(method.clone()));
            }
            if *units == 0 {
                return Err(PriceTableError::ZeroValue);
            }
        }
        Ok(())
    }

    /// Units of one method, or `None` if the method is not in the table.
    pub fn units_of(&self, method: &str) -> Option<u32> {
        self.units.get(method).copied()
    }

    /// The canonical encoding. Call [`PriceTable::validate`] first.
    pub fn canonical_json(&self) -> String {
        let entries: Vec<String> = self
            .units
            .iter()
            .map(|(method, units)| format!("\"{method}\":{units}"))
            .collect();
        format!(
            "{{\"units\":{{{}}},\"version\":{}}}",
            entries.join(","),
            self.version
        )
    }

    /// Calculate `price_table_hash = keccak256(canonical_json())`.
    pub fn hash(&self) -> Bytes32 {
        Bytes32(keccak256(self.canonical_json().as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_table_has_the_planned_encoding() {
        let table = PriceTable::initial();
        assert_eq!(table.validate(), Ok(()));
        assert_eq!(
            table.canonical_json(),
            r#"{"units":{"eth_blockNumber":1,"eth_chainId":1,"eth_getBalance":2},"version":1}"#
        );
        assert_eq!(table.units_of("eth_getBalance"), Some(2));
        assert_eq!(table.units_of("eth_call"), None);
    }

    #[test]
    fn initial_table_keeps_its_hash() {
        assert_eq!(
            PriceTable::initial().hash().to_hex(),
            "0xda98f5f3639aec038cc4eafa8881883249966a89123bd2fb42111d30b123f72f"
        );
    }

    #[test]
    fn current_table_has_the_planned_encoding_and_hash() {
        let table = PriceTable::current();
        assert_eq!(table.validate(), Ok(()));
        assert_eq!(
            table.canonical_json(),
            r#"{"units":{"eth_blockNumber":1,"eth_call":3,"eth_chainId":1,"eth_getBalance":2,"eth_getTransactionReceipt":2},"version":2}"#
        );
        assert_eq!(
            table.hash().to_hex(),
            "0x5a43e7886a8b605be5873140f6682098b51d69af2c46f2ccc5ac6670a8408f08"
        );
        assert_eq!(table.units_of("eth_call"), Some(3));
        assert_eq!(table.units_of("eth_getTransactionReceipt"), Some(2));
        // The initial methods keep their units.
        for (method, units) in &PriceTable::initial().units {
            assert_eq!(table.units_of(method), Some(*units), "{method}");
        }
        assert_eq!(table.units_of("eth_getLogs"), None);
    }

    #[test]
    fn serde_json_form_equals_canonical_form() {
        for table in [PriceTable::initial(), PriceTable::current()] {
            assert_eq!(
                serde_json::to_string(&table).unwrap(),
                table.canonical_json()
            );
        }
    }

    #[test]
    fn validate_rejects_bad_names_and_zero_values() {
        let mut table = PriceTable::initial();
        table.units.insert("eth_\"x".to_owned(), 1);
        assert!(matches!(
            table.validate(),
            Err(PriceTableError::BadMethodName(_))
        ));
        let mut table = PriceTable::initial();
        table.units.insert("eth_x".to_owned(), 0);
        assert_eq!(table.validate(), Err(PriceTableError::ZeroValue));
        let table = PriceTable {
            units: BTreeMap::new(),
            version: 1,
        };
        assert_eq!(table.validate(), Err(PriceTableError::Empty));
    }

    #[test]
    fn unit_change_changes_the_hash() {
        let mut table = PriceTable::initial();
        let base = table.hash();
        table.units.insert("eth_getBalance".to_owned(), 3);
        assert_ne!(table.hash(), base);
    }
}
