# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:24-alpine AS application
WORKDIR /build
RUN apk add --no-cache curl
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY html/ ./html/
COPY ui/ ./ui/
COPY public/ ./public/
COPY worker/ ./worker/
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY tests/ ./tests/
COPY migrations/ ./migrations/
RUN npm run build && npm test

FROM --platform=$BUILDPLATFORM alpine:3.23 AS geolite2
RUN apk add --no-cache ca-certificates curl jq
COPY scripts/download-geolite2.sh /usr/local/bin/download-geolite2
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN sh /usr/local/bin/download-geolite2 /data/geolite2

FROM node:24-alpine
ARG BUILD_REVISION=development
ENV NODE_ENV=production BUILD_REVISION=$BUILD_REVISION
RUN apk add --no-cache ca-certificates curl \
    && mkdir -p /app /var/lib/ipinfo/geolite2 /var/lib/ipinfo/statistics \
    && chown -R 10001:10001 /var/lib/ipinfo
COPY --from=application /build/dist/server.mjs /app/server.mjs
COPY --from=geolite2 /data/geolite2/ /data/geolite2/
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/ipinfo/THIRD_PARTY_NOTICES.md
USER 10001:10001
WORKDIR /app
VOLUME ["/var/lib/ipinfo/geolite2"]
VOLUME ["/var/lib/ipinfo/statistics"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["node", "/app/server.mjs"]
