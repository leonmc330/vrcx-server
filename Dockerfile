# VRCX as a web page.
#
# Stage 1 builds VRCX's own Vue frontend from a pinned upstream tag. That needs
# only Node and Vite - the .NET backend and Electron shell are never involved,
# because this replaces them.
#
# Stage 2 runs a small Node server that serves that frontend and implements the
# backend calls it makes: the VRChat API with a cookie jar, SQLite, settings.

FROM node:24-alpine AS frontend
ARG VRCX_REF=v2026.07.18
RUN apk add --no-cache git
WORKDIR /build
RUN git clone --depth 1 --branch ${VRCX_REF} https://github.com/vrcx-team/VRCX.git .
RUN npm ci --no-audit --no-fund
# Writes to /build/build/html, per src/vite.config.js
RUN npx vite build src

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production     VRCX_DATA=/data     PORT=8080     HOST=0.0.0.0     TZ=UTC

RUN apk add --no-cache tzdata curl

COPY --from=frontend /build/build/html ./html
COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3     CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "/app/server.js"]
