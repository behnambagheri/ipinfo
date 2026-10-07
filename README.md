# IPinfo — bea.sh

An IP and network diagnostic service for [bea.sh](https://bea.sh), with a
responsive daisyUI 5 / Tailwind CSS 4 interface. The blue accents,
background grid, and system/light/dark themes follow [bea.sh](https://bea.sh).

The HTML, query builder, copy actions, usage dialog, and OpenStreetMap view are
shared by the Cloudflare Worker and self-hosted container. CSS is compiled and
embedded; the browser does not download a CSS framework.

Auto keeps the original behavior: the address used to connect to this service.
The optional IPv4 and IPv6 buttons leave the page unchanged when Auto already
shows an address of the selected family. Switching uses only this deployment's
configured family endpoints; no external IP discovery service is contacted.
Manual address lookups hide the selector. If switching is unavailable, the
current page stays available with an explanatory message. The choice is not
stored as a default. Long IPv6 addresses use smaller type and wrap between
hextets; copying still includes the complete address.

## Deployment options

| | Cloudflare Worker | Container / Kubernetes |
| --- | --- | --- |
| Runtime | Cloudflare edge JavaScript | [echoip](https://github.com/mpolden/echoip) |
| Visitor IP | Cloudflare's `CF-Connecting-IP` | Connection peer; optionally trusted proxy headers |
| Visitor geolocation | Cloudflare request metadata | Bundled GeoLite2 databases |
| Explicit `?ip=` lookup | HTTPS [IPWHOIS](https://ipwhois.io/documentation) with [IP Guide](https://ip.guide) fallback, cached for 24 hours | Local GeoLite2 lookup |
| Reverse DNS | Unavailable | Enabled by default |
| TCP port checks | Unavailable (HTTP 501) | Opt-in via `ECHOIP_PORT_LOOKUP=true` |

The hosted Worker serves visitor metadata without external lookup requests.
Explicit public-IP lookups send only the queried address to IPWHOIS and, if it
fails or reaches its quota, IP Guide. Reserved
and private addresses return an address-only result without contacting a
provider. IPWHOIS's free endpoint has a documented limit of 1,000 requests/day
per requesting IP and no uptime SLA. Workers may share outbound addresses
and exhaust this quota. IP Guide provides fallback network/location data;
unavailable fields stay blank. If both providers fail, the Worker returns HTTP
502. Each provider request has a four-second timeout. The
self-hosted container has no external geolocation API dependency.
IP geolocation is approximate and can reflect a VPN or provider's location.

## API

```sh
curl https://ip.bea.sh              # Plain IP for CLI clients
curl https://ip.bea.sh/json         # Full JSON
curl -H 'Accept: application/json' https://ip.bea.sh
curl 'https://ip.bea.sh/json?ip=8.8.8.8'
curl 'https://ip.bea.sh/json?ip=2606:4700:4700::1111'
curl https://ip.bea.sh/country
curl https://ip.bea.sh/country-iso
curl https://ip.bea.sh/city
curl https://ip.bea.sh/coordinates
curl https://ip.bea.sh/asn
curl https://ip.bea.sh/asn-org
curl -fsSL 'https://ip.bea.sh/ip?family=4'
curl -fsSL 'https://ip.bea.sh/json?family=6'
curl -fsS 'https://ip.bea.sh/json?family=auto'
```

A browser requesting `text/html` gets the interface at `/`. API clients get
plain text or JSON, depending on the endpoint and `Accept` header. The Worker
returns IPv6 decimal addresses as strings to preserve their full precision.
Its responses use `Cache-Control: no-store` to prevent sharing visitor data.
The custom-lookup cache contains only public-IP geolocation, never visitor
responses, headers, or user agents.

### Selecting an address family

`family=auto` (or no parameter) preserves the connection's address. `family=4`
and `family=6` require IPv4 and IPv6 respectively, on `/`, `/ip`, `/json`, and
individual metadata endpoints. A matching connection responds immediately.
A mismatch redirects the **client** with HTTP 307 to the configured family-only
origin, retaining the path and query. Use `curl -L` to follow the redirect.
The server never fetches an IP discovery service or derives an IPv4 address
from an unrelated IPv6 address. The result is the public address seen by the
service, which may belong to a VPN, proxy, or NAT gateway.

| Condition | HTTP status |
| --- | --- |
| Requested family matches the connection | 200, subject to the normal endpoint result |
| Configured alternate-family origin | 307; follow with `-L` |
| No usable alternate-family origin | 503 with a JSON error |
| Redirected or dedicated endpoint still receives the wrong family | 409 with a JSON error; no redirect loop |
| Invalid/duplicate `family`, or `family=4/6` combined with `ip` | 400 with a JSON error |

**Hosted Cloudflare limitation:** `ip.bea.sh` currently supports strict matching
but cannot switch between families. Cloudflare rejected this zone's per-record
IPv4-only/IPv6-only settings (error 9227). A DNS-only alias to a Cloudflare
family endpoint was also rejected before the Worker (error 1014), and was
removed. Therefore a request for the opposite family returns 503. No alternate
family URL is configured in production. This is not a complete cross-family
switching deployment; Cloudflare must enable suitable family-only routing
before that capability can be enabled on this zone.

Cloudflare's [DNS record settings](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/)
describe `ipv4_only` and `ipv6_only`, but they are not available to every zone.
[Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
require proxied DNS, which otherwise advertises both address families. Do not
disable IPv6 zone-wide to implement a single service's selector.

`curl -4` and `curl -6` control curl's connection family. A VPN or proxy can
forward the request over a different family; the service cannot recover an
unobserved address from that request. `family=4/6` prevents returning the wrong
family in that situation.

For deployments with suitable client-facing endpoints, configure these origins
(no credentials, path, query, or fragment):

| Variable | Purpose | Default |
| --- | --- | --- |
| `IPINFO_AUTO_URL` | Main origin used by the browser's Auto button | Current origin |
| `IPINFO_IPV4_URL` | Same service via A-only DNS / IPv4 transport | Unconfigured |
| `IPINFO_IPV6_URL` | Same service via AAAA-only DNS / IPv6 transport | Unconfigured |
| `IPINFO_REQUIRED_FAMILY` | Optional `4` or `6` on a dedicated family deployment | No constraint |

An HTTPS request only redirects to HTTPS. Each family endpoint must serve the
same application and preserve the real connection IP. The DNS and entire proxy
path must enforce the family, not merely the origin server's address. The
client needs connectivity to the selected family. IPv6-only clients using DNS64
and NAT64 may still reach an A-only endpoint through an IPv4 gateway; the
returned IPv4 is that gateway's public address.

Worker deployments use Wrangler `vars` for these settings. Add each usable
family hostname to Wrangler `routes` as well, so automatic GitHub deployments
retain its routing. The browser preflights the same first-party API, validates
the returned family, and navigates to that endpoint for its connection metadata.

## Local development

```sh
npm ci
npm run build
npm test
npm run dev
```

Open `http://localhost:8787`. Local preview uses the actual loopback connection
address and has no Cloudflare geolocation metadata; explicit public-IP lookup
and interface interactions work. Edit `html/` for both interfaces and
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
so a successful deployment confirms the new code is serving requests.

For a manual deployment through the official Wrangler CLI:

```sh
npm run build
npx wrangler@4.148.0 deploy --var BUILD_REVISION:$(git rev-parse HEAD)
```

The deploying credential needs account **Workers Scripts: Edit** and zone
**Workers Routes: Edit**, **DNS: Edit**, and **Zone: Read** for `bea.sh`.
Cloudflare can replace an existing DNS record when attaching a Worker custom
domain; review the current record before the first cutover. No origin server,
container, database, or secret is required by the Worker.

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

The image runs as UID/GID `10001` on port `8080`. It builds echoip from a pinned,
SHA-256-verified source archive for each target architecture. Its public
upstream base images come from Docker Hub, and npm dependencies come from
`registry.npmjs.org`.

GeoLite2 ASN, City, and Country databases come from one resolved release of
[rabuchaim/geolite2mirror](https://github.com/rabuchaim/geolite2mirror).
Every download must match its published SHA-256 digest. Rebuild with
`--no-cache` to refresh the database snapshot. This product includes GeoLite2
data created by [MaxMind](https://www.maxmind.com), subject to the
[GeoLite End User License Agreement](https://www.maxmind.com/en/geolite/eula),
which incorporates CC BY-SA 4.0. Users and redistributors must follow its
attribution and database update/removal requirements.

| Environment variable | Default |
| --- | --- |
| `ECHOIP_LISTEN` | `:8080` |
| `ECHOIP_CACHE_SIZE` | `0` |
| `ECHOIP_TRUSTED_HEADERS` | Empty (no trusted headers) |
| `ECHOIP_PORT_LOOKUP` | `false` |
| `ECHOIP_REVERSE_LOOKUP` | `true` |
| `ECHOIP_DISABLE_CUSTOM_IP` | `false` |
| `ECHOIP_PROFILING` | `false` |
| `ECHOIP_SPONSOR` | `false` |
| `ECHOIP_TEMPLATE_DIR` | `/data/html` |
| `ECHOIP_ASN_DATABASE` | `/data/geolite2/GeoLite2-ASN.mmdb` |
| `ECHOIP_CITY_DATABASE` | `/data/geolite2/GeoLite2-City.mmdb` |
| `ECHOIP_COUNTRY_DATABASE` | `/data/geolite2/GeoLite2-Country.mmdb` |

Boolean options accept `true`, `false`, `1`, or `0`. An explicitly empty
database path disables that database. Explicit command arguments override
all environment configuration.

Only configure trusted headers behind a proxy you control that overwrites
them, for example `ECHOIP_TRUSTED_HEADERS=CF-Connecting-IP` behind a restricted
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
values file. Verify that the ingress overwrites the selected header and
restrict direct access to the service. TLS, replicas, image pull secrets,
resources, scheduling, and image tags/digests are configurable in
`charts/ipinfo/values.yaml`. Use a SHA tag or digest for reproducible production
deployments. The chart runs without a service-account token, privileges, or a
writable root filesystem and includes startup, readiness, and liveness probes.

### Family endpoint configuration

The chart exposes the same API settings. For an ingress that already serves
the main, A-only, and AAAA-only hostnames, add this to its values file:

```yaml
network:
  autoURL: https://ipinfo.example.com
  ipv4URL: https://ipv4.ipinfo.example.com
  ipv6URL: https://ipv6.ipinfo.example.com
  requiredFamily: ""
```

Configure those hosts and certificates in `ingress.hosts` / `ingress.tls`.
The chart does not create DNS or add IPv6 connectivity to your cluster. A
separate family deployment can set `network.requiredFamily` to `"4"` or `"6"`.
Only trust client-IP headers overwritten by your own ingress. These are chart
configuration instructions; the hosted service remains on Cloudflare.

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

The container uses [echoip](https://github.com/mpolden/echoip) (BSD 3-Clause),
GeoLite2/MaxMind, and the database mirror. The Worker uses Cloudflare metadata
and IPWHOIS with IP Guide fallback for explicit public-IP lookup. IP Guide
credits [MaxMind](https://www.maxmind.com) for its location data. Both interfaces use daisyUI,
Tailwind CSS, and [OpenStreetMap](https://www.openstreetmap.org/copyright).
