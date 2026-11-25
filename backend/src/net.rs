use std::net::IpAddr;

use axum::http::HeaderMap;

/// Resolves the end-user IP address behind the local reverse proxy.
///
/// Caddy forwards `CF-Connecting-IP` verbatim and sets `X-Real-IP` from the direct peer, so
/// `CF-Connecting-IP` has to win whenever Cloudflare proxying is enabled. `X-Forwarded-For` is
/// deliberately ignored: the proxy normalizes it to the same value as `X-Real-IP`, and a
/// client-supplied forwarded chain must never be trusted.
///
/// This is only safe while the backend is unreachable from untrusted networks. See
/// the reverse-proxy trust requirements in `docs/deployment.md`.
pub fn resolve_client_ip(headers: &HeaderMap) -> Option<IpAddr> {
    header_ip(headers, "cf-connecting-ip").or_else(|| header_ip(headers, "x-real-ip"))
}

fn header_ip(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

/// Reads one cookie value out of a request's `Cookie` header.
///
/// Hand-rolled because the project has no cookie crate and needs exactly one lookup. Splits on
/// `;`, then on the first `=` only, so a value containing `=` survives intact.
pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let header = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;

    header.split(';').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;

        (key.trim() == name).then(|| value.trim().to_owned())
    })
}

/// Groups an address into the unit a rate limiter should count against.
///
/// IPv4 is counted per address. IPv6 is counted per `/64`, because a single client is routinely
/// handed a whole prefix and could otherwise rotate through addresses to reset every window.
pub fn rate_limit_subject(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(address) => address.to_string(),
        IpAddr::V6(address) => {
            let octets = address.octets();
            let mut prefix = [0u8; 16];
            prefix[..8].copy_from_slice(&octets[..8]);
            format!("{}/64", std::net::Ipv6Addr::from(prefix))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::*;

    #[test]
    fn prefers_cloudflare_header_over_real_ip() {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", "203.0.113.9".parse().unwrap());
        headers.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());

        assert_eq!(
            resolve_client_ip(&headers),
            Some(IpAddr::V4(Ipv4Addr::new(198, 51, 100, 7)))
        );
    }

    #[test]
    fn falls_back_to_real_ip() {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", " 203.0.113.9 ".parse().unwrap());

        assert_eq!(
            resolve_client_ip(&headers),
            Some(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9)))
        );
    }

    #[test]
    fn ignores_forwarded_for_and_malformed_values() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());
        headers.insert("x-real-ip", "not-an-ip".parse().unwrap());

        assert_eq!(resolve_client_ip(&headers), None);
    }

    #[test]
    fn buckets_ipv6_by_prefix() {
        let first = IpAddr::V6("2001:db8:1:2:3:4:5:6".parse::<Ipv6Addr>().unwrap());
        let second = IpAddr::V6(
            "2001:db8:1:2:ffff:ffff:ffff:ffff"
                .parse::<Ipv6Addr>()
                .unwrap(),
        );

        assert_eq!(rate_limit_subject(first), rate_limit_subject(second));
        assert_eq!(rate_limit_subject(first), "2001:db8:1:2::/64");
    }

    #[test]
    fn reads_a_named_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            "other=1; __Host-gl_mod=abc.def=; trailing=2"
                .parse()
                .unwrap(),
        );

        assert_eq!(
            cookie_value(&headers, "__Host-gl_mod"),
            Some("abc.def=".to_owned())
        );
        assert_eq!(cookie_value(&headers, "missing"), None);
    }

    #[test]
    fn missing_cookie_header_is_none() {
        assert_eq!(cookie_value(&HeaderMap::new(), "__Host-gl_mod"), None);
    }

    #[test]
    fn buckets_ipv4_exactly() {
        let address = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9));

        assert_eq!(rate_limit_subject(address), "203.0.113.9");
    }
}
