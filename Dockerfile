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
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
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
# `npm ci --omit=dev` fails on this lockfile — it reports bufferutil,
# utf-8-validate and node-gyp-build (optional native accelerators pulled in via
# `ws`) as missing, while a plain `npm ci` installs fine. So do the reproducible
# install the lockfile does support, then drop dev dependencies. Same end state,
# and it does not require regenerating the lockfile, which would churn versions
# far outside this change.
RUN npm ci \
    && npm prune --omit=dev \
    && npm cache clean --force \
    && mkdir -p /app/data /app/public /app/docs /app/dist \
    && chown -R pwuser:pwuser /app

COPY --from=builder --chown=pwuser:pwuser /app/dist ./dist
COPY --chown=pwuser:pwuser public/ ./public/
COPY --chown=pwuser:pwuser docs/ ./docs/

USER pwuser

EXPOSE 3000
CMD ["node", "dist/index.js"]
