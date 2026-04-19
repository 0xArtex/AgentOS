FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app

# Run as the built-in `node` user (uid 1000) rather than root. This drops the
# blast radius of any process-level escape — including the Playwright Chromium
# spawned for social-account automation.
COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev \
    && chown -R node:node /app \
    && mkdir -p /app/data /app/public /app/docs /app/dist \
    && chown -R node:node /app/data /app/public /app/docs /app/dist

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node public/ ./public/
COPY --chown=node:node docs/ ./docs/

USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
