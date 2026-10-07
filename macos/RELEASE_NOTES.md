IPinfo for macOS checks `ip.bea.sh` and `ip.behnam.pro` concurrently using the current network connection.

- Matching IP, location, and ASN results show only `ip.bea.sh`.
- Different results show both services, with their IP and available diagnostic fields.
- Unreachable services remain visible with an error; a failed check is never treated as a match.
- Refresh after changing a VPN or proxy. Copy either IP or open either website.
- Universal app for Apple Silicon and Intel Macs running macOS 13 or later. No Node.js, Docker, or local server is required.

Install from the project tap:

```sh
brew install --cask behnambagheri/tap/ipinfo
open -a IPinfo
```

After `brew tap behnambagheri/tap`, the shorter `brew install --cask ipinfo` command also works.

This initial release is ad-hoc signed, not Developer ID signed or Apple-notarized. macOS may require approval through **System Settings → Privacy & Security → Open Anyway** after the first launch attempt. The cask preserves standard macOS quarantine checks.

Source, database-release identifiers, User-Agent, derived decimal IP, and container-only reverse DNS are excluded from equality checks. IP addresses are normalized; all available shared location and ASN fields must match. Checks do not force IPv4 or IPv6, so different routes or address families can produce different results.
