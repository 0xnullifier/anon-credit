//! Observed source address (implementation.md section 14).
//!
//! - With IP capture off (the normal profile), the gateway does not read the peer address or
//!   any forwarding header. The observed IP is `"unavailable"`.
//! - With IP capture on (the demo profile), the observed IP is the socket peer address.
//! - Only a socket peer in the trusted proxy list can set the observed IP with the configured
//!   forwarding header (for example `X-Forwarded-For`). The gateway reads the chain from the
//!   trusted end (right to left), skips trusted proxies, and takes the first other address.
//!   The proxy hop is shown separately. A forwarding header from any other peer is ignored.

use anon_credit_protocol::admin::IP_UNAVAILABLE;
use anon_credit_protocol::api::IpAttribution;
use axum::http::{HeaderMap, HeaderName};
use std::net::{IpAddr, SocketAddr};

/// Default forwarding header.
pub const DEFAULT_FORWARDED_HEADER: &str = "x-forwarded-for";

/// The observed source of one request.
#[derive(Clone, PartialEq, Eq)]
pub struct Observed {
    /// Observed source IP, or `"unavailable"`.
    pub ip: String,
    /// Source of the attribution.
    pub attribution: IpAttribution,
    /// Socket address of the trusted proxy hop.
    pub proxy_hop: Option<String>,
}

impl std::fmt::Debug for Observed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Do not print addresses in debug output. Logs must not have them.
        f.write_str("Observed(..)")
    }
}

impl Observed {
    /// The value when IP capture is off.
    pub fn unavailable() -> Self {
        Self {
            ip: IP_UNAVAILABLE.to_owned(),
            attribution: IpAttribution::Unavailable,
            proxy_hop: None,
        }
    }
}

/// Rules for the observed source address.
#[derive(Debug, Clone)]
pub struct PeerPolicy {
    capture: bool,
    trusted: Vec<IpAddr>,
    header: HeaderName,
}

fn canonical(ip: IpAddr) -> IpAddr {
    ip.to_canonical()
}

impl PeerPolicy {
    /// Make a policy. `capture` is `DEMO_IP_LOGGING`.
    pub fn new(capture: bool, trusted: Vec<IpAddr>, header: HeaderName) -> Self {
        Self {
            capture,
            trusted: trusted.into_iter().map(canonical).collect(),
            header,
        }
    }

    /// `true` if IP capture is on.
    pub fn captures(&self) -> bool {
        self.capture
    }

    fn is_trusted(&self, ip: IpAddr) -> bool {
        self.trusted.contains(&canonical(ip))
    }

    /// The observed source of a request from `peer` with `headers`.
    pub fn observe(&self, peer: SocketAddr, headers: &HeaderMap) -> Observed {
        if !self.capture {
            return Observed::unavailable();
        }
        let peer_ip = canonical(peer.ip());
        let socket = Observed {
            ip: peer_ip.to_string(),
            attribution: IpAttribution::Socket,
            proxy_hop: None,
        };
        if !self.is_trusted(peer_ip) {
            return socket;
        }
        match self.forwarded_client(headers) {
            Some(client) => Observed {
                ip: client.to_string(),
                attribution: IpAttribution::TrustedProxy,
                proxy_hop: Some(peer_ip.to_string()),
            },
            None => socket,
        }
    }

    /// Read the client address from the forwarding header of a trusted proxy.
    ///
    /// Return `None` if the header is absent or an entry does not parse before the client
    /// entry. All header lines form one list, in order.
    fn forwarded_client(&self, headers: &HeaderMap) -> Option<IpAddr> {
        let mut entries = Vec::new();
        for value in headers.get_all(&self.header) {
            let text = value.to_str().ok()?;
            entries.extend(text.split(',').map(str::trim));
        }
        let mut last_trusted = None;
        for entry in entries.iter().rev() {
            let ip = parse_entry(entry)?;
            match self.is_trusted(ip) {
                true => last_trusted = Some(ip),
                false => return Some(ip),
            }
        }
        // Every entry is a trusted proxy. Use the leftmost one.
        last_trusted
    }
}

/// Parse one forwarding entry: an IP address, or an address with a port.
fn parse_entry(entry: &str) -> Option<IpAddr> {
    entry
        .parse::<IpAddr>()
        .or_else(|_| entry.parse::<SocketAddr>().map(|s| s.ip()))
        .ok()
        .map(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(xff: &[&str]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for value in xff {
            map.append("x-forwarded-for", HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn policy(capture: bool, trusted: &[&str]) -> PeerPolicy {
        PeerPolicy::new(
            capture,
            trusted.iter().map(|t| t.parse().unwrap()).collect(),
            HeaderName::from_static(DEFAULT_FORWARDED_HEADER),
        )
    }

    fn peer(text: &str) -> SocketAddr {
        text.parse().unwrap()
    }

    #[test]
    fn capture_off_gives_unavailable() {
        let observed =
            policy(false, &["10.0.0.1"]).observe(peer("10.0.0.1:443"), &headers(&["203.0.113.5"]));
        assert_eq!(observed, Observed::unavailable());
    }

    #[test]
    fn untrusted_peer_header_is_ignored() {
        let observed =
            policy(true, &[]).observe(peer("198.51.100.4:5000"), &headers(&["203.0.113.5"]));
        assert_eq!(observed.ip, "198.51.100.4");
        assert_eq!(observed.attribution, IpAttribution::Socket);
        assert_eq!(observed.proxy_hop, None);
    }

    #[test]
    fn trusted_proxy_chain_is_read_from_the_right() {
        let policy = policy(true, &["10.0.0.1", "10.0.0.2"]);
        let observed = policy.observe(
            peer("10.0.0.1:443"),
            &headers(&["1.1.1.1, 203.0.113.5", "10.0.0.2"]),
        );
        assert_eq!(observed.ip, "203.0.113.5");
        assert_eq!(observed.attribution, IpAttribution::TrustedProxy);
        assert_eq!(observed.proxy_hop.as_deref(), Some("10.0.0.1"));
    }

    #[test]
    fn bad_entry_falls_back_to_socket_peer() {
        let observed =
            policy(true, &["10.0.0.1"]).observe(peer("10.0.0.1:443"), &headers(&["garbage"]));
        assert_eq!(observed.ip, "10.0.0.1");
        assert_eq!(observed.attribution, IpAttribution::Socket);
    }

    #[test]
    fn ipv4_mapped_peer_matches_ipv4_proxy() {
        let observed = policy(true, &["10.0.0.1"]).observe(
            peer("[::ffff:10.0.0.1]:443"),
            &headers(&["203.0.113.9:1234"]),
        );
        assert_eq!(observed.ip, "203.0.113.9");
    }
}
