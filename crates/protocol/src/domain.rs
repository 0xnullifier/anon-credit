//! Operation domain tags for signed messages and configuration digests.
//!
//! Each tag is 32 bytes: the ASCII name, then zero bytes to fill 32 bytes.
//! A different tag for each operation stops a signature for one operation from
//! being valid for another operation.

/// Length of a domain tag in bytes.
pub const DOMAIN_TAG_LEN: usize = 32;

/// A fixed 32-byte domain tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DomainTag(pub [u8; DOMAIN_TAG_LEN]);

impl DomainTag {
    /// Make a tag from ASCII text of at most 32 bytes.
    ///
    /// Use this only in constants. Text that is too long or not ASCII stops the build.
    pub const fn from_ascii(text: &str) -> Self {
        let bytes = text.as_bytes();
        assert!(bytes.len() <= DOMAIN_TAG_LEN, "domain tag text is too long");
        let mut out = [0u8; DOMAIN_TAG_LEN];
        let mut i = 0;
        while i < bytes.len() {
            assert!(
                bytes[i].is_ascii_graphic(),
                "domain tag text must be printable ASCII"
            );
            out[i] = bytes[i];
            i += 1;
        }
        Self(out)
    }

    /// The tag bytes.
    pub const fn as_bytes(&self) -> &[u8; DOMAIN_TAG_LEN] {
        &self.0
    }
}

/// Domain of the deployment configuration digest (`deployment_id`).
pub const DEPLOYMENT: DomainTag = DomainTag::from_ascii("anon-credit/deployment");

/// Domain of the session-open signature. See [`crate::open`].
pub const OPEN: DomainTag = DomainTag::from_ascii("anon-credit/open");

/// Domain of the spend signature.
pub const SPEND: DomainTag = DomainTag::from_ascii("anon-credit/spend");

/// Domain of the session-status signature. See [`crate::status`].
pub const STATUS: DomainTag = DomainTag::from_ascii("anon-credit/status");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_distinct() {
        let tags = [DEPLOYMENT, OPEN, SPEND, STATUS];
        for (i, a) in tags.iter().enumerate() {
            for b in &tags[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn tag_is_zero_padded() {
        let text = b"anon-credit/spend";
        assert_eq!(&SPEND.0[..text.len()], text);
        assert!(SPEND.0[text.len()..].iter().all(|b| *b == 0));
    }
}
