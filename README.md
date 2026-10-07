# IPinfo — bea.sh

An IP and network diagnostic service for [bea.sh](https://bea.sh), with a
responsive daisyUI 5 / Tailwind CSS 4 interface. The blue accents,
background grid, and system/light/dark themes follow [bea.sh](https://bea.sh).

The HTML, query builder, copy actions, usage dialog, and OpenStreetMap view are
shared by the Cloudflare Worker and self-hosted container. CSS is compiled and
embedded; the browser does not download a CSS framework.

Auto keeps the original behavior: the address used to connect to this service.
The optional IPv4 and IPv6 buttons leave the page unchanged when Auto already
shows an address of the selected family. Otherwise they contact the corresponding
[ipify endpoint](https://www.ipify.org/) from the browser only when clicked,
then look up that address here. IPv6 requires a working IPv6 connection;
if detection fails, the current page stays available with an explanatory message.
The choice is not stored as a default. Long IPv6 addresses use smaller type and
wrap between hextets; copying still includes the complete address.

## Deployment options

### Desktop apps: macOS, Linux, and Windows

Every desktop download contains both the graphical app and a standalone CLI.
Linux and Windows have one archive per CPU architecture (AMD64 and ARM64), with
no separate CLI-only edition. The CLI does not load Electron or need a graphical
session, so the same package works on a server. No Node.js installation or local
GeoLite2 database is required.

| System | Downloads | Graphical launcher | CLI |
| --- | --- | --- | --- |
| macOS 13+ | Universal DMG or ZIP; Homebrew cask | IPinfo.app | `ipinfo` |
| Linux, glibc | AMD64 or ARM64 `.tar.gz`, `.deb`, `.rpm`, `.pkg.tar.zst` | `IPinfo-GUI` / `ipinfo-gui` | `ipinfo` |
| Windows 10+ | AMD64 or ARM64 `.zip`; Scoop and WinGet manifests | `IPinfo-GUI.exe` / `ipinfo-gui` | `ipinfo.exe` |

Extract the whole Linux/Windows archive and keep its files together. Run the CLI
directly from the extracted folder, or use the included user installer:

```sh
# Linux: no administrator permissions required.
./install.sh
~/.local/bin/ipinfo
~/.local/bin/ipinfo 1.2.3.4
```

```powershell
# Windows: run in PowerShell; no administrator permissions required.
.\install.ps1
# Restart the terminal after installation, then:
ipinfo
ipinfo 1.2.3.4
```

The Linux installer puts the app in `~/.local/share/IPinfo`, adds a desktop entry,
and links `ipinfo` and `ipinfo-gui` in `~/.local/bin`; add that directory to PATH
if necessary. It honors `XDG_DATA_HOME`. The Windows installer puts the app in
`%LOCALAPPDATA%\Programs\IPinfo`, adds it to the user PATH, and creates a Start
menu shortcut. Portable use needs no installation. Windows executables are
currently unsigned. Linux graphical mode needs a desktop, GTK 3/NSS/audio
libraries, and Chromium sandbox support; a current Ubuntu 22.04+ or equivalent
distribution is recommended. Alpine/musl is unsupported. Servers can run the
standalone CLI without those graphical libraries.

#### Linux package managers

Releases also provide a combined **`bea-ipinfo`** native package for each Linux
architecture. It contains both interfaces, installs the `ipinfo` and
`ipinfo-gui` commands, and adds IPinfo to the desktop application menu.
The distinct package name avoids confusing this application with other IPinfo
clients. Settings remain in the user's configuration directory after upgrades
and removal.

Download the file matching your distribution and CPU from the release, verify
it against `SHA256SUMS`, then run the matching command from its download folder:

```sh
# Debian / Ubuntu, AMD64:
sudo apt install ./bea-ipinfo_1.2.0-1_amd64.deb
# Debian / Ubuntu, ARM64:
sudo apt install ./bea-ipinfo_1.2.0-1_arm64.deb

# Rocky / RHEL / Fedora, AMD64:
sudo dnf install ./bea-ipinfo-1.2.0-1.x86_64.rpm
# Rocky / RHEL / Fedora, ARM64:
sudo dnf install ./bea-ipinfo-1.2.0-1.aarch64.rpm

# Arch Linux, AMD64:
sudo pacman -U ./bea-ipinfo-1.2.0-1-x86_64.pkg.tar.zst
# Arch Linux ARM, ARM64:
sudo pacman -U ./bea-ipinfo-1.2.0-1-aarch64.pkg.tar.zst

ipinfo
ipinfo 1.2.3.4
ipinfo-gui
```

Arch Linux officially supports x86_64; the ARM64 package targets Arch Linux ARM.
Packages use glibc, so Alpine/musl is unsupported. The CLI requires glibc 2.28+
and libstdc++; GUI libraries are recommended/optional dependencies. On servers,
use `apt install --no-install-recommends ./bea-ipinfo_...deb` or
`dnf install --setopt=install_weak_deps=False ./bea-ipinfo-...rpm` to avoid
installing desktop libraries. To run the GUI on a minimal installation, install
the package's recommended dependencies first. Native packages ship the Chromium
sandbox helper owned by root with mode 4755; no `--no-sandbox` flag is needed.

Remove the application with `sudo apt remove bea-ipinfo`,
`sudo dnf remove bea-ipinfo`, or `sudo pacman -R bea-ipinfo`. Installing a newer
downloaded package with the same installation command upgrades it.

These commands install **downloaded release files**. This project currently has
no public apt, dnf, or pacman repository and no AUR listing; commands such as
`apt install bea-ipinfo` or `pacman -S bea-ipinfo` will require a published
repository first. The prepared 1.2.0 artifacts become downloadable only after
that release is published.

#### Windows package managers

Windows Package Manager (**WinGet**) is the Microsoft-supported option. Each
release generates submission-ready manifests for **`BehnamBagheri.IPinfo`**, with
native x64 and ARM64 ZIPs and the actual SHA-256 hashes of that release. WinGet
installs the complete archive and exposes both `ipinfo` and `ipinfo-gui` commands.
The entry must be submitted and accepted into Microsoft's registry before this
public install command is available:

```powershell
# Available only after WinGet registry acceptance:
winget install --id BehnamBagheri.IPinfo --exact
winget upgrade --id BehnamBagheri.IPinfo --exact
winget uninstall --id BehnamBagheri.IPinfo --exact
```

Releases also include a **Scoop** manifest, which needs no community registry
submission. With Scoop already installed, install directly from the published
manifest URL:

```powershell
# Available after the 1.2.0 release and its assets are published:
scoop install https://github.com/behnambagheri/ipinfo/releases/download/v1.2.0/ipinfo.json
ipinfo
ipinfo 1.2.3.4
ipinfo-gui
# Or open IPinfo from the Start menu.
scoop uninstall ipinfo
```

Scoop chooses the native architecture, verifies the ZIP checksum, installs both
commands, and creates an IPinfo Start menu shortcut. For an upgrade before a
maintained Scoop bucket exists, uninstall and install the next release's
manifest URL; user settings are preserved. WinGet's portable installation has
command aliases; use `ipinfo-gui` to open its graphical interface. Windows
executables remain unsigned, so SmartScreen may require approval.

See the official [WinGet manifest documentation](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest)
and [Scoop app-manifest documentation](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests).

#### Source and timeout settings

The default source is **Auto**. It contacts both endpoints concurrently, with
a **five-second hard deadline per service**. A timeout never counts as matching;
the working result remains visible alongside a short error for the unavailable
service. If both fail, both errors are shown. Results from different addresses
or networks are never silently merged.

Choose **Auto**, **ip.bea.sh only**, or **ip.behnam.pro only** in the GUI and save
settings. Single-source mode contacts only the selected endpoint. The GUI and
CLI share the same source and timeout preferences. The timeout can be any whole
number from 1 to 30 seconds.

```sh
ipinfo config --source ip.bea.sh       # Save one source for both interfaces.
ipinfo config --source ip.behnam.pro
ipinfo config --source auto --timeout 5
ipinfo config                        # Print the saved preferences.
ipinfo --source ip.bea.sh --timeout 2  # Override this lookup only.
```

Preferences are stored at `~/.config/ipinfo/settings.json` on Linux (or under
`XDG_CONFIG_HOME`), `%APPDATA%\IPinfo\settings.json` on Windows, and
`~/Library/Application Support/IPinfo/settings.json` on macOS. IP results are
not saved. Reopen the GUI after changing settings from another process.

#### macOS / Homebrew

In Auto mode, the native macOS app checks both `https://ip.bea.sh/json` and
`https://ip.behnam.pro/json` concurrently using the Mac's current network
connection. It shows only `ip.bea.sh` when both diagnostic results match,
and shows both services when they differ. If either check fails, both service
statuses remain visible; a timeout or error never counts as an identical result.
Refresh after changing a VPN or proxy. Each panel supports copying its IP and
opening the corresponding website.
The same cask also installs an `ipinfo` terminal command:

```sh
ipinfo                              # Check your public IP through both services.
ipinfo 1.2.3.4                      # Look up a particular IPv4 address.
ipinfo 2606:4700:4700::1111          # Look up an IPv6 address.
ipinfo --json 8.8.8.8               # Structured output for scripts.
ipinfo --help
```

In Auto mode, both current-IP and explicit-IP checks query the two sources. Matching results
print only `ip.bea.sh`; differences print both. A failed source appears with an
error alongside the other result. JSON output is an object keyed by the displayed
service names. Exit codes are `0` when all selected requests succeed, `1` if any fails,
and `2` for invalid arguments. Invalid IP addresses are rejected before requests.
The CLI does not open a window. If a shell function or alias already uses the
name `ipinfo`, run `command ipinfo` or update that wrapper to forward arguments
to the installed executable.

```sh
brew install --cask behnambagheri/tap/ipinfo
open -a IPinfo
```

Alternatively, add the tap first and use the short cask name:

```sh
brew tap behnambagheri/tap
brew install --cask ipinfo
```

The tap is [behnambagheri/homebrew-tap](https://github.com/behnambagheri/homebrew-tap).
This is a project-maintained cask, not a listing in the official Homebrew cask
repository. Without adding the tap first, use the fully qualified install name.
The unrelated `brew install ipinfo` formula is a different project.

The universal app supports Apple Silicon and Intel Macs on macOS 13 or later.
It requires no Node.js, Docker, local service, or local GeoLite2 databases.
The app sends lookup requests only to the two named services and does not
persist diagnostic results. Requests may be counted by each service's existing
aggregate statistics. It does not force an address family, so the endpoints
can observe different IPv4/IPv6 addresses or VPN/proxy routes.

Equality compares normalized IP addresses plus all shared location and ASN
fields: country, country code, Iran flag, city, region, region code, postal code,
time zone, latitude, longitude, ASN, and network organization. A populated field
on only one service counts as a difference; empty/null fields count as missing.
Source, database-release identifiers, User-Agent, derived decimal IP, and
container-only reverse DNS are excluded from equality checks.

The initial release is ad-hoc signed and is not Apple-notarized. After attempting
to open the downloaded app, macOS may require **System Settings → Privacy &
Security → Open Anyway**. The cask preserves normal Gatekeeper/quarantine checks.
A Developer ID certificate and notarization credentials are needed to remove
that first-launch approval requirement.

```sh
brew upgrade --cask ipinfo
brew uninstall --cask ipinfo
```

To build and test the app on macOS:

```sh
npm ci
npm run package:macos
dist/macos/IPinfo.app/Contents/MacOS/IPinfo --check
open dist/macos/IPinfo.app
```

Packaging runs the Swift comparison and CLI tests, compiles both CPU architectures,
generates the app icon from the existing logo, signs the bundle, and writes a
ZIP, DMG, SHA-256 checksums, signing-status JSON, and ready-to-publish cask into
`dist/macos/`. The DMG includes the app and an Applications shortcut for a manual
drag-and-drop installation. Homebrew installs both the app and its CLI; manual
DMG users can run `/Applications/IPinfo.app/Contents/Helpers/ipinfo` directly.
The optional
`MACOS_SIGNING_IDENTITY` and `MACOS_NOTARY_PROFILE` environment variables select
Developer ID signing and a preconfigured `notarytool` keychain profile.
The `Desktop apps` GitHub Actions workflow builds pull requests and publishes
version-tagged releases only after all five native packaging jobs and package-manager
manifest validation pass. Tags
must match the numeric `package.json` version.
After publishing a release, copy its generated `ipinfo.rb` asset into the tap's
`Casks/ipinfo.rb`; always use the checksum of the actual published ZIP.

#### Developer ID signing and notarization

Gatekeeper checks downloaded software's developer identity and notarization,
independently of whether it asks for protected permissions. The app needs only
outbound HTTPS requests and has no special entitlements. A DMG alone does not
change Gatekeeper approval. The supported distribution path uses a **Developer
ID Application** certificate with its private key, hardened-runtime signing,
Apple notarization, and stapled tickets for both the app and DMG.

Configure these repository Actions secrets together to activate that path:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded exported Developer ID Application `.p12`, including its private key |
| `MACOS_CERTIFICATE_PASSWORD` | Password used to export the `.p12` |
| `MACOS_SIGNING_IDENTITY` | Full `Developer ID Application: … (TEAMID)` identity |
| `APPLE_ID` | Apple account for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer team ID |

See [Apple's Developer ID distribution guidance](https://developer.apple.com/developer-id/)
and [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
Use the account's certificate export and repository secret settings; do not
commit credentials or paste them into source files.

The workflow imports credentials into a temporary runner keychain, signs the
nested CLI before the app, submits and staples the app, generates ZIP and DMG,
then signs, notarizes, and staples the DMG. Gatekeeper assessments must pass
before signed artifacts are published. Cleanup restores the runner's keychain
search list and deletes the temporary certificate and keychain. Pull request
builds never receive these secrets. With no signing secrets configured, builds
remain ad-hoc signed; a partially configured set fails rather than publishing
a release with an ambiguous signing state. `distribution-status.json` records
the actual release status, and notarized casks omit the first-launch caveat.

#### Linux and Windows packaging

```sh
npm ci
npm run test:desktop
npm run package:desktop -- linux-x64
npm run package:desktop -- linux-arm64
npm run package:desktop -- win32-x64
npm run package:desktop -- win32-arm64
npm run package:linux -- linux-x64
npm run package:linux -- linux-arm64
npm run package:windows-manifests
```

Each target writes a combined archive and checksum under `dist/desktop/`.
Packaging bundles the CLI as a Node.js single executable, verifies the downloaded
runtime against its official SHA-256 checksum, and bundles the graphical app
with Electron. The runtime versions are pinned in `scripts/package-desktop.mjs`.
After building each Linux archive, `package:linux` packages the same staged
runtime as `.deb`, `.rpm`, and `.pkg.tar.zst` files. Its build-only nFPM tool is
pinned to 2.47.0 with committed checksums; no nFPM installation is required.
Build native packages on Linux AMD64/ARM64 or macOS ARM64. System package files
are root-owned, desktop libraries are optional, and preferences stay outside
the package tree. Package metadata uses `Unknown` for the project-wide license
because this repository does not declare one; third-party license notices remain
included.

`package:windows-manifests` reads both built Windows ZIPs and writes the Scoop
manifest and three WinGet manifests into `dist/package-managers/`. Every URL,
version, architecture, nested executable path, and checksum comes from that
release's actual artifacts. The manifest-validation job regenerates these from the downloaded
CI artifacts, rather than reusing local hashes. Extract `IPinfo-winget-manifests.zip`
from a published release, validate its version directory with
`winget validate --manifest <directory>`, then submit that directory to
`microsoft/winget-pkgs` using the official manifest workflow. Submission is a
separate maintainer action; the release workflow does not submit or publish a
package-manager registry entry automatically.

Cross-packaging is supported with snapshots and code caches disabled; release
CI builds and tests on native Linux and Windows runners for both architectures.
The GUI is sandboxed, loads local assets, and can request only the two fixed
lookup services through a narrow preload interface. No remote website is loaded
inside the app. Runtime and interface licenses ship in the archives.

On a matching native system, run `npm run verify:desktop` to test the packaged CLI,
saved preferences, and real GUI renderer behavior. Linux CI uses `xvfb-run -a`
for graphical tests. The release job waits for macOS and all four Linux/Windows
jobs, verifies their checksums, then uploads all archives, six native Linux
packages, and Windows package-manager manifests with one combined
`SHA256SUMS`. PR/manual builds create Actions artifacts without publishing a
release; publishing requires a matching version tag.
Linux jobs test Debian installation directly, RPM installation in a Rocky Linux
container, and x86_64 Arch installation in the official Arch container. These
checks run the installed CLI without desktop libraries, verify both command
links and the sandbox helper's owner/mode, reinstall/remove the package, and
verify that saved settings survive. Run `scripts/verify-linux-package.sh` only
in a disposable build host or container; it installs and removes system files.

### Hosted service

| | Cloudflare Worker | Container / Kubernetes |
| --- | --- | --- |
| Runtime | Shared IPinfo JavaScript handler on Cloudflare | Shared IPinfo JavaScript handler on Node.js 24 |
| Visitor IP | Cloudflare's `CF-Connecting-IP` | Connection peer; optionally trusted proxy headers |
| Visitor geolocation | Cloudflare request metadata | Bundled GeoLite2 databases |
| Explicit `?ip=` lookup | Owned GeoLite2 databases packaged as Worker Static Assets; up to 1,000 results per Worker isolate, expiring after 24 hours | Local GeoLite2 lookup |
| Reverse DNS | Unavailable | Enabled by default |
| TCP port checks | Enabled on `ip.bea.sh` via `IPINFO_PORT_LOOKUP=true` | Opt-in via `IPINFO_PORT_LOOKUP=true` |

The hosted Worker serves visitor metadata without external lookup requests.
Explicit public-IP lookups read our own GeoLite2 ASN, City, and Country data
through an internal Static Assets binding. No IP is sent to a third-party
geolocation API. Reserved/private addresses return an address-only result;
unknown public addresses retain their IP with unavailable fields omitted.
Database failures return HTTP 502 JSON; browser requests retain the interface
with an error message and retry link. Failed lookups are not cached.
The self-hosted container reads the same database types from its image. Both
deployments use our own shared handler, renderer, API schema, and public assets.
The container has no echoip source download, Go build, binary, or runtime dependency.
IP geolocation is approximate and can reflect a VPN or provider's location.

## API

The Worker and container expose the same lookup routes. Append `?ip=8.8.8.8`
or an IPv6 address for a custom lookup; otherwise the service reports the visitor.

| Endpoint | Result |
| --- | --- |
| `/`, `/ip` | Plain IP (`/` also provides HTML or JSON through content negotiation) |
| `/usage` | Terminal-friendly plain-text guide with commands and endpoint descriptions |
| `/json` | Complete available information |
| `/ip-decimal` | Decimal IP; IPv6 uses an exact decimal string |
| `/country`, `/country-iso`, `/country-ir` | Country name, ISO code, whether the IP is in Iran |
| `/city`, `/region-name`, `/region-code`, `/postal-code` | Location fields |
| `/asn`, `/asn-org` | ASN and network organization |
| `/timezone` | Time zone |
| `/coordinates`, `/latitude`, `/longitude` | Geographic coordinates |
| `/user-agent` | Raw request User-Agent |
| `/database-info` | Actual database build dates and update status |
| `/healthz`, `/health` | Service health, build revision, and active database release |
| `/stats`, `/stats.json` | Statistics page and JSON request counters for this deployment only, when configured |
| `/port/<number>` | TCP check when enabled; otherwise HTTP 501 |

```sh
curl ip.bea.sh/usage
curl https://ip.bea.sh/json
curl 'https://ip.behnam.pro/json?ip=8.8.8.8'
curl 'https://ip.behnam.pro/json?ip=2606:4700:4700::1111'
curl 'https://ip.behnam.pro/region-name?ip=81.2.69.160'
```

`/usage` returns aligned plain text for all clients, including browsers, without
requiring an IP lookup or working geolocation databases. Examples use the
requested service's origin and reflect its custom-lookup, port-testing, and
statistics configuration. HEAD returns the same headers without a body.
Reading the guide does not increment diagnostic usage counters.

Lookups support GET and HEAD; OPTIONS returns the CORS policy. Missing fields
return HTTP 404. JSON omits unavailable fields. `user_agent` is consistently the
raw string on both deployments. Reverse DNS adds `hostname` on the container
when enabled and available, with a one-second bound on waiting for DNS.

A browser requesting `text/html` gets the interface at `/`. API clients get
plain text or JSON, depending on the endpoint and `Accept` header. The Worker
returns IPv6 decimal addresses as strings to preserve their full precision.
Its responses use `Cache-Control: no-store` to prevent sharing visitor data.
The custom-lookup cache contains only public-IP geolocation, never visitor
responses, headers, or user agents.

The Worker configuration sets `IPINFO_CACHE_SIZE=1000` and
`IPINFO_PORT_LOOKUP=true`. The result cache uses RAM in each Worker isolate;
it evicts the least recently used result when full, expires results after
24 hours, and invalidates them when the database release changes. Setting
the cache size to `0` disables result caching. `IPINFO_CACHE_SIZE` and
`IPINFO_PORT_LOOKUP` are also accepted and take precedence over the legacy
`ECHOIP_` names.

`/port/443` checks only the connecting visitor's IP, ignoring any `?ip=`
parameter. Worker checks use a TCP handshake with a five-second timeout and
close the socket afterward. Cloudflare blocks private destinations, its own
IP ranges, and SMTP port 25; these return `status: "blocked"` rather than a
claim that the destination port is closed. See the
[Cloudflare TCP socket restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations).

API responses use the address visible on the connection, with no forced
address-family override. `curl -4` and `curl -6` choose curl's connection
family, but a VPN or proxy can forward the request over a different family.
The browser's optional IPv4/IPv6 buttons use ipify only when clicked; this
browser behavior does not change the API's default connection detection.

## Usage statistics

Each deployment displays **only its own usage**: `ip.bea.sh` and
`ip.behnam.pro` have independent counters, even though their aggregate data
shares one Cloudflare D1 database. The site identity is fixed in the runtime,
never selected by the Host header, a query parameter, or a report payload.
There is no public cross-site or combined statistics endpoint.

When enabled, the footer shows recorded requests and links to `/stats`.
`/stats.json` returns `site`, `metric`, `timezone`, `started_at`,
`last_request_at`, `updated_at`, `stale`, `all_time`, `today`,
`last_30_days`, and 30 `daily` entries. Each period contains `total`,
`web`, `api`, and `errors`. Daily periods use UTC; the 30-day window
includes today. Zero-traffic days appear with zero counts. `started_at` is
stored as an absolute timestamp. Browser timestamps and reporting-window start/end
times use the user's browser time zone, including daylight-saving rules. Daily
counts retain their UTC aggregation boundaries; the page labels them as reporting
days and displays their full local intervals instead of claiming local-day totals.
`started_at` is null until the first recorded request. All statistics responses use
`Cache-Control: no-store`; they are not cached by the service worker.

A diagnostic GET counts once: the IP/location/ASN routes, custom lookups, and
port checks. HTML responses count as web; JSON/plain-text responses count as
API, regardless of the User-Agent. Browsers can also make API requests. Bots
and scripts count too; these figures are **requests, not unique visitors**.
Diagnostic errors count in the total and in the errors subset. HEAD, OPTIONS,
other methods, health probes, database metadata, public assets, unknown routes,
statistics reads, and reporting requests are excluded. Counters retain no
visitor IPs, lookup addresses, cookies, or complete User-Agent strings.
Tracking begins when enabled; no historical usage is inferred.

### Cloudflare setup

`wrangler.jsonc` binds `USAGE_DB` to `bea-ipinfo-usage`.
`migrations/0001_usage.sql` creates the counters table. CI applies outstanding
D1 migrations before deploying the Worker; its API token requires account
**D1: Edit** in addition to the existing deployment permissions.

Generate a high-entropy reporting token (32–256 URL-safe characters), install
it as the Worker secret `IPINFO_STATS_REPORT_TOKEN`, and store the same value
in the Kubernetes Secret described below. Do not use a Cloudflare account API
token as the reporting credential. Wrangler preserves installed Worker secrets
on subsequent deployments. Never commit either token.

The Worker increments one daily aggregate atomically for each diagnostic GET,
using `ctx.waitUntil` so it does not delay the diagnostic response. D1 errors
or exhausted limits leave diagnostics available, but those failed writes are
not recorded or replayed. Statistics therefore describe **recorded requests**,
not an exact billing ledger. There is no sampling or in-memory total that resets
on Worker redeployment. Reads use the primary database.

D1 and Workers have separate account-wide included allowances; D1 counts rows
read/written, not HTTP visits. Keeping aggregates avoids storing one database
row per request, but each Worker increment still consumes a write. There is no
plan upgrade in this setup. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

### Container / Kubernetes setup

The container records counters in atomic per-process JSON files in
`IPINFO_STATS_DIR`. Diagnostic responses wait only for local persistence,
never for the connection to Cloudflare. A local disk failure leaves diagnostics
available; a later successful snapshot can recover counts still in memory.
A crash while storage is failing can lose those unpersisted counts.

Every minute, each replica scans the shared spool and sends changed cumulative
source/day counts to `https://ip.bea.sh/internal/usage` over authenticated
HTTPS. The collector always attributes that credential to `ip.behnam.pro`.
It merges counters using maximum values: duplicate reports, concurrent replicas,
out-of-order arrivals, and lost acknowledgements cannot double count usage.
Replacement pods can resend files left by earlier processes. Source files are
retained so pending counts survive extended outages; do not delete the spool
while reports may be pending. Restoring an older copy can lose counts that were
never reported, but cannot reduce totals already stored centrally.

All replicas periodically refresh a shared-site snapshot, including replicas
with no traffic. Public container statistics show the latest successfully
retrieved central snapshot and can lag by roughly one reporting interval.
An outage keeps the saved snapshot available, explicitly marked `stale` after
a failed synchronization or two reporting intervals. Before the first successful
synchronization, `/stats.json` returns HTTP 503 rather than invented zeros.
The website continues serving diagnostics during synchronization failures.

Create a Secret named `ipinfo-statistics` with the reporting token in its
`token` key, then enable these Helm values:

```yaml
statistics:
  enabled: true
  endpoint: https://ip.bea.sh/internal/usage
  existingSecret: ipinfo-statistics
  secretKey: token
  persistence:
    enabled: true
    storageClass: nfs-client
    size: 1Gi
```

The chart creates a ReadWriteMany PVC, `<release>-ipinfo-statistics`, and
mounts it separately from database-update storage. Use a storage class that
supports shared volumes and atomic rename, or supply
`statistics.persistence.existingClaim`. Each process writes only its own
file; replicas never update another process's source file. Shared persistent
storage lets pending reports survive replacing any or all replicas. With
`statistics.persistence.enabled: false`, the chart uses emptyDir: pending
counts then survive only container restarts in the same pod, not pod replacement.
The central database retains already reported counts in either mode.

For Docker, mount a durable volume at `/var/lib/ipinfo/statistics` and provide
`IPINFO_STATS_ENDPOINT=https://ip.bea.sh/internal/usage`,
`IPINFO_STATS_REPORT_TOKEN`, and optionally `IPINFO_STATS_DIR`.
The endpoint is deliberately restricted to the configured HTTPS collector;
credentials cannot follow redirects to another host. Omit the endpoint to disable
container statistics. Worker statistics are enabled by the D1 binding.

Set `IPINFO_STATS_PROXY` (Helm: `statistics.proxy`) to an HTTP, HTTPS, SOCKS5,
or SOCKS5h proxy when the container cannot reach Cloudflare directly. This affects
only statistics reporting and refreshes. For credentials, use
`statistics.proxySecret.name` and `.key`; a referenced Secret overrides the
plain proxy value. TLS verification remains enabled. The transport rejects
redirects, bounds request time and response size, and passes credentials through
curl's stdin configuration rather than process arguments or logs.

The `bea` deployment uses its existing egress proxy, `http://172.25.50.122:7890`,
because direct connections from its pods to `ip.bea.sh:443` timed out. Statistics
use a shared NFS claim and two replicas, with a pinned container image.

## Local development

The interface includes the original network-locator logo in
`public/brand/ipinfo.svg`, used for the SVG favicon, multi-size ICO, Apple touch
icon, regular/maskable PWA icons, install dialog, and offline screen. The header
uses text branding. `npm run build` generates the
raster icons and an offline page, then packages the same public assets into
the Worker and the container service. To change the logo, edit the SVG
and rebuild; no external image service is used at runtime.

### Installable app

IPinfo has a web app manifest and a service worker. Serve it over HTTPS
(localhost also works during development). On supported browsers, choose
**Install app** in the footer alongside About, Contact, and Usage. A native
install prompt opens when available; otherwise the button shows browser
instructions. In Safari on iPhone or iPad, choose **Share → Add to Home
Screen**. On Mac Safari, choose **File → Add to Dock**. The installed app starts
at `/` in its own window, without retaining a previous IP lookup in its launch
URL. Browser installation behavior varies; see
[MDN's installability guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

The service worker caches only public branding, manifest, and offline-page
assets. Visitor HTML, IP results, API responses, and external requests are
never put in its cache. Offline app navigation shows a reconnect screen;
network and location diagnostics require a live connection. New asset builds
change the service worker's cache version and remove old IPinfo asset caches.
Both deployments serve `/manifest.webmanifest`, `/sw.js`, `/offline.html`,
`/favicon.ico`, `/brand/ipinfo.svg`, and `/icons/*` directly. Reverse proxies
must forward these paths and permit the service worker and manifest in any
additional Content Security Policy they apply.

### Build and preview

```sh
npm ci
npm run build
npm test
npm run dev
```

Open `http://localhost:8787`. Local preview uses the actual loopback connection
address and has no Cloudflare geolocation metadata; explicit public-IP lookup
requires `npm run geoip:prepare` first. Interface interactions work. Edit
`html/` for both interfaces and
`ui/styles.css` for theme tokens. `scripts/build-worker.mjs` compiles the
supported Go-template expressions to JavaScript, then bundles `dist/worker.mjs`.
Generated CSS and bundles are ignored by Git.

## Cloudflare Worker

`wrangler.jsonc` targets account `65a8188637073a50148b1e6e59e1c1a9`
(`Bagheri.linuxmail@gmail.com's Account`) and custom domain `ip.bea.sh`.
Workers.dev and preview URLs are disabled. Worker observability is disabled
to avoid retaining visitor requests in application logs.

Every successful push to `main` automatically deploys the `bea-ipinfo` Worker
to `https://ip.bea.sh` through GitHub Actions after validation and container
smoke tests pass. Manual workflow runs on `main` deploy too. Pull requests and
version tags do not deploy the production Worker.

The repository needs encrypted Actions secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The workflow uses the official Cloudflare Wrangler
action and checks `/healthz` until its `revision` matches the pushed commit,
so a successful deployment confirms the new code and database release are
serving requests. It also verifies live IPv4 and IPv6 GeoLite2 lookups.

### Database updates and storage

Worker Static Assets work on the Workers Free plan without enabling R2.
The database files are split into 4 MiB chunks, below Cloudflare's 25 MiB
per-file asset limit, and uploaded with the Worker as one version. A small
IPv4/IPv6 prefix index and a bounded 4 MiB page cache avoid loading the full
production databases into Worker memory. Public `/__geoip/*` requests return
404; only the internal asset binding reads the database files.

The footer shows one update date when ASN, City, and Country share the same local
date, and separate dates otherwise. These
come from the databases' embedded build timestamps, rather than release upload
dates or filesystem modification times. Visible dates and tooltips use the browser's
time zone; ISO timestamps in the API and HTML datetime attributes retain the exact
instant. `/database-info` exposes the timestamps
as JSON without requiring a visitor IP. The Worker reads its deployed manifest;
the container reads metadata from its open database readers, including custom
paths and disabled databases. This endpoint needs no international connection.

Every CI run resolves the latest published release from
[P3TERX/GeoLite.mmdb](https://github.com/P3TERX/GeoLite.mmdb) once, downloads
all three files from that release, verifies their published SHA-256 digests,
checks their MaxMind metadata, and compares lookups with a reference reader.
Each database's actual build date must be no more than 30 days old.
The `main` deployment uploads those exact verified assets and pins the Worker
to their content-derived release identifier. If preparation or upload fails,
the currently deployed Worker and its assets remain available. Result-cache
keys include the release, so new deployments cannot reuse an older database's
lookup result.

The databases are current as of the last successful deployment, according to
that mirror; nothing downloads at request time. There is no scheduled refresh.
Push to `main` or run the CI workflow manually on `main` to refresh without
changing application code. Local `npm run build` builds the UI and Worker only;
`npm run geoip:prepare` explicitly fetches and packages fresh databases.
Container builds download their own latest snapshot from the same mirror;
an existing running container retains its bundled snapshot until updated.

For a manual deployment through the official Wrangler CLI, with
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set:

```sh
npm ci
npm run geoip:prepare
npm run build
npm test
npm run geoip:verify
GEOIP_RELEASE=$(node -p 'require("./dist/geolite2/manifest.json").release')
npx wrangler deploy --var BUILD_REVISION:$(git rev-parse HEAD) --var GEOIP_RELEASE:$GEOIP_RELEASE
EXPECTED_REVISION=$(git rev-parse HEAD) EXPECTED_GEOIP_RELEASE=$GEOIP_RELEASE node scripts/verify-worker.mjs
```

The deploying credential needs account **Workers Scripts: Edit** and zone
**Workers Routes: Edit**, **DNS: Edit**, and **Zone: Read** for `bea.sh`.
Cloudflare can replace an existing DNS record when attaching a Worker custom
domain; review the current record before the first cutover. The Worker needs
no origin server, container, R2 bucket, or runtime secret.
Its deployment includes the database assets.

## Automatic container database updates

The container runs a built-in updater. It checks once after startup and then
at the configured interval, **seven days (`168h`) by default**. A failed check
retries after at most one hour, while the existing databases continue serving.
A release with unchanged checksums updates only the last successful check;
it does not claim a new database update or download the same files again.

Downloads use one resolved P3TERX release, published SHA-256 checksums, expected
MMDB types, and build dates that cannot go backwards. All three databases are
installed as one immutable generation and reloaded together without restarting
the HTTP service. Response caches distinguish generations. An incomplete,
corrupt, or unreachable download leaves the active generation and last
successful update time intact. The previous generation is retained locally.

The footer displays **Last successful update** separately from the database
build date. The initial value comes from the image's verified download receipt;
later values are recorded after a runtime update is fully installed.
`/database-info` exposes update status, interval, last successful check, and
last error. Proxy credentials are never returned by this endpoint or written
into update error messages.

### Helm / ConfigMap settings

```yaml
databaseUpdates:
  enabled: true
  interval: "168h" # Use "24h" for daily checks.
  proxy: ""       # For example: "http://proxy.example:3128"
```

The chart generates `<release>-ipinfo-database-updates`, with an `updates.json`
key, and mounts it at `/etc/ipinfo/updates.json`. The app rereads this file at
least every minute; projected ConfigMap changes take effect after Kubernetes
refreshes the mount. Change the Helm values for a durable configuration change,
or edit that ConfigMap for an immediate operational adjustment. A later Helm
upgrade rewrites the generated ConfigMap from Helm values.

To use your own ConfigMap, set `databaseUpdates.existingConfigMap` to its name
and provide the same `updates.json` key:

```json
{"enabled": true, "interval": "24h", "proxy": "http://proxy.example:3128"}
```

HTTP, HTTPS, SOCKS5, and SOCKS5h proxy URLs are supported. This proxy applies
only to database update requests, including release metadata and all assets.
For a proxy URL held in a Secret, set `databaseUpdates.proxySecret.name` and
`databaseUpdates.proxySecret.key` (default key: `proxy`). The explicit proxy
environment value overrides the ConfigMap's proxy field.

Each pod gets its own writable `/var/lib/ipinfo/geolite2` volume while the
container root remains read-only. Default `emptyDir` storage survives container
restarts within the pod; replacing the pod discards runtime downloads and starts
from its bundled snapshot. To retain downloads across pod replacements, provide
`databaseUpdates.existingClaim` and `replicaCount: 1`. An update directory must
have a single writer; the chart rejects a shared claim with multiple replicas.

### Environment settings / Docker

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `IPINFO_DATABASE_UPDATE_ENABLED` | `true` | Enable or disable automatic checks |
| `IPINFO_DATABASE_UPDATE_INTERVAL` | `168h` | Duration using `ms`, `s`, `m`, `h`, or `d`; `24h` for daily checks |
| `IPINFO_DATABASE_UPDATE_PROXY` | empty | Optional proxy URL for update downloads |
| `IPINFO_DATABASE_UPDATE_CONFIG` | empty | Optional JSON configuration file |
| `IPINFO_DATABASE_UPDATE_DIR` | `/var/lib/ipinfo/geolite2` | Writable generation/state directory |

Explicit environment variables override the JSON file. Environment changes
require a container restart; the mounted JSON configuration reloads dynamically.
Automatic updates require all three configured databases to be GeoLite2.
Disabled databases and custom GeoIP2 databases continue to work without being
replaced by the public GeoLite2 updater.

```sh
docker run --rm --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  -p 127.0.0.1:8080:8080 \
  -v ipinfo-geolite2:/var/lib/ipinfo/geolite2 \
  -e IPINFO_DATABASE_UPDATE_INTERVAL=168h \
  -e IPINFO_DATABASE_UPDATE_PROXY=http://proxy.example:3128 \
  ghcr.io/behnambagheri/ipinfo:latest
```

The image declares a writable update volume even when a named volume is omitted.
Use a named volume to retain downloads when recreating a Docker container.
Cloudflare Workers continue to update their packaged databases during deployment;
the container's runtime timer and ConfigMap settings apply to the self-hosted service.

## Container

```sh
docker run --rm --name ipinfo \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8080:8080 ghcr.io/behnambagheri/ipinfo:latest
curl http://127.0.0.1:8080/json
```

Or build locally:

```sh
docker build --pull -t ipinfo:local .
bash scripts/smoke-container.sh ipinfo:local
```

The image runs our own bundled Node.js service as UID/GID `10001` on port `8080`.
The Worker and container bundles are built from the same handler and templates.
A generic MIT-licensed `mmdb-lib` reader handles local MaxMind files; no echoip
code or binary is needed at build or runtime. Base images come from Docker Hub,
and npm dependencies come from `registry.npmjs.org`. curl provides verified
HTTPS database downloads and HTTP/HTTPS/SOCKS proxy transports at runtime.
Image builds run the shared API, database, updater, and proxy tests.
Pass `--build-arg BUILD_REVISION=$(git rev-parse HEAD)` when building locally to
populate `/healthz`; CI always supplies the deployed commit.

GeoLite2 ASN, City, and Country databases come from one resolved release of
[P3TERX/GeoLite.mmdb](https://github.com/P3TERX/GeoLite.mmdb).
Every download must match its published SHA-256 digest. Rebuild with
`--no-cache` to refresh the database snapshot. This product includes GeoLite2
data created by [MaxMind](https://www.maxmind.com), subject to the
[GeoLite End User License Agreement](https://www.maxmind.com/en/geolite/eula),
which incorporates CC BY-SA 4.0. Users and redistributors must follow its
attribution and database update/removal requirements.

| Environment variable | Default |
| --- | --- |
| `IPINFO_LISTEN` | `:8080` |
| `IPINFO_CACHE_SIZE` | `0` |
| `IPINFO_TRUSTED_HEADERS` | Empty (no trusted headers) |
| `IPINFO_PORT_LOOKUP` | `false` |
| `IPINFO_REVERSE_LOOKUP` | `true` |
| `IPINFO_DISABLE_CUSTOM_IP` | `false` |
| `IPINFO_ASN_DATABASE` | `/data/geolite2/GeoLite2-ASN.mmdb` |
| `IPINFO_CITY_DATABASE` | `/data/geolite2/GeoLite2-City.mmdb` |
| `IPINFO_COUNTRY_DATABASE` | `/data/geolite2/GeoLite2-Country.mmdb` |

Boolean options accept `true`, `false`, `1`, or `0`. An explicitly empty
database path disables that database. `IPINFO_CACHE_SIZE` bounds an optional
in-memory geolocation cache; user agents and reverse DNS are not cached.

Existing `ECHOIP_*` settings for the listed options remain migration aliases.
An explicit `IPINFO_*` value takes precedence. The chart now sets `IPINFO_*`.
The image entrypoint is `node /app/server.mjs`; old echoip CLI arguments,
profiling routes, sponsor options, and external Go template directories are
no longer supported. The existing shared HTML is compiled into both bundles.
Historical template attribution remains in `THIRD_PARTY_NOTICES.md`.

Only configure trusted headers behind a proxy you control that overwrites
them, for example `IPINFO_TRUSTED_HEADERS=CF-Connecting-IP` behind a restricted
Cloudflare origin. Otherwise use the connection peer. Enabling port checks
allows probing the requesting address from the container's network.

## Kubernetes / Helm

```sh
helm upgrade --install ipinfo ./charts/ipinfo \
  --namespace ipinfo --create-namespace
kubectl -n ipinfo port-forward service/ipinfo-ipinfo 8080:80
```

To expose an ingress with your controller's trusted client IP header:

```sh
helm upgrade --install ipinfo ./charts/ipinfo \
  --namespace ipinfo --create-namespace \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=ipinfo.example.com' \
  --set trustedHeaders=X-Real-IP
```

Quote indexed `--set` arguments in shells that expand brackets, or use a
values file. Helm replaces the default hosts list when you override an indexed
host; the chart defaults omitted or empty host paths to `/` with `pathType: Prefix`.
Verify that the ingress overwrites the selected header and
restrict direct access to the service. TLS, replicas, image pull secrets,
resources, scheduling, and image tags/digests are configurable in
`charts/ipinfo/values.yaml`. Use a SHA tag or digest for reproducible production
deployments. The chart runs without a service-account token, privileges, or a
writable root filesystem and includes startup, readiness, and liveness probes.

### Updating an existing deployment

Run these commands from the project directory after the new container image
has finished publishing to GHCR. These examples use the `services` namespace;
replace it with the namespace used when installing your release.

```sh
helm upgrade ipinfo ./charts/ipinfo \
  --namespace services \
  --reuse-values \
  --wait --timeout 5m

kubectl -n services rollout restart deployment/ipinfo-ipinfo
kubectl -n services rollout status deployment/ipinfo-ipinfo --timeout=5m
```

`helm upgrade` applies the local chart and `--reuse-values` preserves the
release's existing settings, including its ingress host and trusted headers.
Proceed with the restart after the upgrade succeeds.

By default, the chart uses the `latest` image tag with `imagePullPolicy: Always`.
An upgrade that leaves the pod template unchanged does not restart existing
pods. The explicit restart creates new pods that resolve the current `latest`
image; the rollout status command waits for them to become ready. If only the
published image changed, run just the two `kubectl` commands above.

For a release pinned to a SHA tag or digest, update `image.tag` or `image.digest`
through Helm instead. A configured digest takes precedence over the tag;
restarting pods alone keeps the pinned image.

## GitHub Actions / GHCR

`.github/workflows/ci.yml` runs on main pushes, version tags, pull requests,
and manual dispatch. It builds the UI and Worker, runs endpoint/security
tests, checks shell syntax, lints/renders Helm, and smoke-tests the real
container before publication.

Successful main/tag/manual runs publish Linux AMD64 and ARM64 images to
`ghcr.io/behnambagheri/ipinfo` using the repository's `GITHUB_TOKEN` and
`packages: write` permission. Tags include `latest` on main, `sha-<commit>`,
and semver tags for `v*` releases. Pull requests do not publish images.
The Helm package is downloadable as a workflow artifact. No registry
password or external CI service is required.

GitHub initially creates some container packages as private. Set the IPinfo
package visibility to public in GitHub Packages if anonymous users cannot
pull it; private pulls require credentials via `imagePullSecrets`.

## Credits

Both deployments run the shared IPinfo service maintained in this repository.
The container uses mmdb-lib (MIT) for local reads. Historical template
attribution to echoip (BSD 3-Clause) is retained in THIRD_PARTY_NOTICES.md.
Both use GeoLite2/MaxMind and the database mirror. The Worker uses Cloudflare metadata
and owned GeoLite2 databases for explicit public-IP lookup.
GeoLite2 data is created by [MaxMind](https://www.maxmind.com). Both interfaces use daisyUI,
Tailwind CSS, and [OpenStreetMap](https://www.openstreetmap.org/copyright).
