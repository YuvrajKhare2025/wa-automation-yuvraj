# --- WhatsApp Automation — production image ---------------------------------
# whatsapp-web.js drives a real headless Chromium per connected WhatsApp
# account, so this image needs the same system libraries a desktop Chrome
# install would need. This is the same package list already documented in
# README.md's "Requirements" section for a bare Linux server — a container
# needs it for the identical reason (it's still just Linux underneath).
FROM node:20-bookworm-slim

# `chromium` here (not just the shared libs a Chrome binary needs) is
# deliberate: package.json's puppeteer (a dependency of whatsapp-web.js) is
# on v24, and since puppeteer v20 its default `npm install` behavior is to
# download its own ~300MB "Chrome for Testing" build from Google's CDN
# during the postinstall step below. That download has no retry/resume, and
# on a build host with restricted or flaky egress to that CDN — some CI
# runners, some PaaS build sandboxes, some corporate/VPS networks — it just
# hangs or fails, which looks like "the deploy is broken" but is really "the
# build never finished." Installing a real Chromium from Debian's own apt
# mirror (already being hit for the libs below, so no new dependency on
# reachability) and pointing puppeteer at it with the two ENV lines further
# down skips that download entirely — smaller image, faster build, one less
# thing that can fail on a host you don't control the network policy of.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    tini \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
    libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
    libxtst6 lsb-release wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell puppeteer to skip its own Chrome download and use the apt-installed
# Chromium above instead. PUPPETEER_EXECUTABLE_PATH is read automatically by
# puppeteer's launcher (whatsapp-client.js doesn't need to pass
# executablePath itself — this env var alone is enough), and
# PUPPETEER_SKIP_DOWNLOAD has to be set before `npm install` runs below,
# since that's the postinstall step it's suppressing.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Dependencies first, in their own layer — this only re-runs when
# package.json actually changes, not on every code edit. No Chromium
# download happens here now (see ENV lines above), just npm packages.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .
RUN node scripts/patch-wwebjs.js

# Everything that needs to survive a restart or redeploy lives under these
# paths — the SQLite database, the session-signing secret, and every
# tenant's saved WhatsApp login. Mount them as named volumes (see
# docker-compose.yml) or a rebuild wipes every connected account's session.
RUN mkdir -p /app/data /app/.wwebjs_auth /app/.wwebjs_cache \
    && chown -R node:node /app

# Drop root privileges for security — Chromium should never run as root,
# and it prevents host filesystem compromise if the container is escaped.
USER node

VOLUME ["/app/data", "/app/.wwebjs_auth", "/app/.wwebjs_cache"]

ENV NODE_ENV=production
EXPOSE 3000

# tini is the init process (PID 1). It:
#   1. Reaps any orphaned Chromium zombie processes that launcher.js's own
#      child management misses (this matters when Chrome crashes and the
#      cleanup path throws before waitpid).
#   2. Forwards SIGTERM to launcher.js so docker stop triggers the full
#      graceful-shutdown sequence (flush DB, close WhatsApp sessions).
#
# docker-compose.yml also sets `init: true`, which adds a tini from Docker's
# bundled copy. Having tini installed here means raw `docker run` without
# --init also gets correct signal/zombie handling.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "launcher.js"]
