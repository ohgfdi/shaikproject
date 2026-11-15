# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Ledgerly — multi-stage image
#
# Local/dev default is SQLite (no services needed). For a PostgreSQL
# deployment, switch the Prisma provider BEFORE building:
#
#   npm run switch:postgres
#   (against an empty DB) npm run db:reset && npm run db:migrate -- --name postgres-port
#   docker compose --profile pg up --build
#
# The runtime entrypoint (scripts/start.mjs) applies pending migrations and
# then starts Next.js. Secrets arrive via environment variables only.
# ---------------------------------------------------------------------------

# ---- Stage 1: dependencies ------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- Stage 2: build --------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate the Prisma client for whichever provider is configured in schema.
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- Stage 3: runtime ------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl && \
    addgroup --system --gid 1001 Ledgerly && \
    adduser --system --uid 1001 Ledgerly
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Full dependency tree is intentionally copied: the runtime runs Prisma
# migrations before boot (scripts/start.mjs). Production hardening: run
# migrations in a dedicated job and prune dev dependencies afterwards.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts ./scripts

# Runtime data (uploads, NDJSON streams, SQLite when used) lives here.
RUN mkdir -p /app/data && chown -R aerolexa:Ledgerly /app/data /app/.next
USER Ledgerly

EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
