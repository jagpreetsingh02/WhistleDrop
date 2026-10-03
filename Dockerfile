# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — production dependencies only.
# Installed in their own stage so the runtime image never contains npm's
# cache, dev dependencies (Jest, ESLint, mongodb-memory-server) or build noise.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no runtime dependency needs an install script, and not
# running them closes a common supply-chain path.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2 — runtime.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

# The official image ships an unprivileged "node" user; never run as root.
USER node

EXPOSE 4000

# Uses Node's built-in fetch, so no curl/wget needs to be installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Exec form: node is PID 1 and receives SIGTERM directly, so the graceful
# shutdown in server.js runs (compose also sets `init: true`).
CMD ["node", "src/server.js"]
