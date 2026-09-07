# Keeps a headless copy of VRCX's own frontend permanently open, so live
# tracking keeps running with no browser tab open. See engine.js for why.

FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates fonts-dejavu-core tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY engine.js ./

ENV CHROMIUM_PATH=/usr/bin/chromium \
    VRCX_URL=http://vrcx:8080/

# node:*-bookworm-slim already ships a "node" user at uid 1000
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/engine.js"]
