# syntax=docker/dockerfile:1
# Build with a BuildKit secret for the private @multiagentcoordinationprotocol
# registry (never a --build-arg — build args are recorded in image history):
#   docker build --secret id=npm_token,env=GITHUB_TOKEN -t macp-control-plane .
FROM node:26-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* .npmrc ./
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN=$(cat /run/secrets/npm_token) \
    npm ci --ignore-scripts \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ src/

RUN npm run build

# --- Runtime ---
FROM node:26-alpine

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json package-lock.json* .npmrc ./
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN=$(cat /run/secrets/npm_token) \
    npm ci --ignore-scripts --omit=dev \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 && \
    npm cache clean --force

COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules/@multiagentcoordinationprotocol/proto node_modules/@multiagentcoordinationprotocol/proto
COPY drizzle/ drizzle/

USER appuser

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "dist/main.js"]
