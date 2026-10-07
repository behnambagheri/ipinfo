IPinfo for macOS checks `ip.bea.sh` and `ip.behnam.pro` concurrently using the current network connection.

- Matching IP, location, and ASN results show only `ip.bea.sh`.
- Different results show both services, with their IP and available diagnostic fields.
- Unreachable services remain visible with an error; a failed check is never treated as a match.
- Refresh after changing a VPN or proxy. Copy either IP or open either website.
- Universal app for Apple Silicon and Intel Macs running macOS 13 or later. No Node.js, Docker, or local server is required.
- Homebrew installs the `ipinfo` CLI alongside the app. Run `ipinfo` for your public IP, `ipinfo 1.2.3.4` for a specific address, or `ipinfo --json` for structured output. IPv6 is supported. Both services are checked in every lookup, with the same match/difference rules as the app.
- ZIP and DMG downloads are included. The DMG supports dragging the app into Applications.

Install from the project tap:

```sh
brew install --cask behnambagheri/tap/ipinfo
open -a IPinfo
```

After `brew tap behnambagheri/tap`, the shorter `brew install --cask ipinfo` command also works.

The release's actual Developer ID signing and notarization status is recorded
in `distribution-status.json` and appended below. Releases built without Apple
credentials remain ad-hoc signed and may require first-launch approval through
**System Settings → Privacy & Security → Open Anyway**. The cask preserves
standard macOS quarantine checks. Packaging supports full signing and
notarization once the repository's Apple credentials are configured.

For releases that are not notarized, Homebrew prints this optional Terminal
workaround at the end of installation. If macOS blocks the app and you trust the
download, remove its download quarantine attribute and reopen it:

```sh
sudo /usr/bin/xattr -r -d com.apple.quarantine "/Applications/IPinfo.app"
open "/Applications/IPinfo.app"
```

Adjust the path for a manual install elsewhere. Homebrew displays your configured
application directory in these commands.

Source, database-release identifiers, User-Agent, derived decimal IP, and container-only reverse DNS are excluded from equality checks. IP addresses are normalized; all available shared location and ASN fields must match. Checks do not force IPv4 or IPv6, so different routes or address families can produce different results.
