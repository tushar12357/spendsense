# syntax=docker/dockerfile:1
# One image runs both processes:  node dist/server.js  (API)   |   node dist/worker.js  (import worker)

FROM node:22-slim AS base
# Prisma's query engine needs OpenSSL.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── Build: full dependency set + TypeScript compile ───────────────────────────
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── Production dependencies only ──────────────────────────────────────────────
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY prisma ./prisma
RUN npx prisma generate

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY package.json ./
# Temp upload dir for background imports; owned by the unprivileged runtime user.
RUN mkdir -p /app/tmp/uploads && chown -R node:node /app/tmp
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
