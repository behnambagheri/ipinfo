# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS echoip
ARG TARGETOS
ARG TARGETARCH
ARG ECHOIP_REV=27646b3c4c39041baf8734063e87e71d46f53362
ARG ECHOIP_SHA256=7f40c90364a8be735952aa7380cb92f36a15f732cb64c9fc29bea3bd4494c3e7
RUN apk add --no-cache curl
WORKDIR /src
RUN curl -fsSL --retry 3 "https://codeload.github.com/mpolden/echoip/tar.gz/${ECHOIP_REV}" -o /tmp/echoip.tar.gz \
    && echo "${ECHOIP_SHA256}  /tmp/echoip.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/echoip.tar.gz --strip-components=1
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/echoip ./cmd/echoip

FROM --platform=$BUILDPLATFORM alpine:3.23 AS geolite2
RUN apk add --no-cache ca-certificates curl jq
COPY scripts/download-geolite2.sh /usr/local/bin/download-geolite2
RUN sh /usr/local/bin/download-geolite2 /data/geolite2

FROM --platform=$BUILDPLATFORM node:24-alpine AS ui
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY html/ ./html/
COPY ui/styles.css ./ui/styles.css
COPY scripts/embed-styles.mjs ./scripts/embed-styles.mjs
RUN npm run build:css

FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=echoip /out/echoip /opt/echoip/echoip
COPY --from=geolite2 /data/geolite2/ /data/geolite2/
COPY --from=ui /build/html/ /data/html/
COPY scripts/entrypoint.sh /usr/local/bin/ipinfo-entrypoint
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/ipinfo/THIRD_PARTY_NOTICES.md
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/ip || exit 1
ENTRYPOINT ["/bin/sh", "/usr/local/bin/ipinfo-entrypoint"]
