# The runtime base is Playwright's own image, not node:alpine.
#
# Alpine is musl, and Playwright publishes no musl Chromium build — its registry
# lists ubuntu and debian builds only. The old image also never ran the browser
# install step, so `npm ci --omit=dev` fetched zero browsers. The result was an
# image that built cleanly, started cleanly, accepted a payment, and then failed
# every browser-backed operation with "browserType.launch: Executable doesn't
# exist". Production escapes this by running bare Node on a VPS with browsers
# cached; every self-hoster following the README did not.
#
# This base ships Chromium and its system dependencies already matched to the
# Playwright version, so the two can never drift apart. Keep the tag in step
# with the `playwright` dependency in package.json.
#
# Builder and runtime share that base deliberately: dependencies are installed
# once and carried across, so the compiled native modules (better-sqlite3) are
# guaranteed to match the runtime's glibc rather than merely resembling it.
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` is rejected here: this lockfile omits bufferutil, utf-8-validate and
# node-gyp-build (optional native accelerators reached through `ws`), which
# newer npm treats as out-of-sync while older npm installs happily. `npm install`
# resolves them instead of refusing. Worth tidying the lockfile separately —
# it is a latent problem for any reproducible install, not just this image.
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.59.1-noble
WORKDIR /app

ENV NODE_ENV=production
# Browsers live outside any one user's home so the unprivileged runtime user can
# read them regardless of who installed them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# `pwuser` is the unprivileged account this base provides — same intent as the
# previous `node` user: drop the blast radius of a process-level escape,
# including the Chromium spawned for social-account automation.
COPY --chown=pwuser:pwuser package.json package-lock.json* ./
COPY --from=builder --chown=pwuser:pwuser /app/node_modules ./node_modules
RUN npm prune --omit=dev \
    && npm cache clean --force \
    && mkdir -p /app/data /app/public /app/docs /app/dist \
    && chown -R pwuser:pwuser /app

COPY --from=builder --chown=pwuser:pwuser /app/dist ./dist
COPY --chown=pwuser:pwuser public/ ./public/
COPY --chown=pwuser:pwuser docs/ ./docs/

USER pwuser

EXPOSE 3000
CMD ["node", "dist/index.js"]
