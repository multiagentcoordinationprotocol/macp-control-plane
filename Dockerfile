FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* .npmrc ./
ARG NPM_TOKEN
RUN echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts && \
    rm -f .npmrc

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ src/

RUN npm run build

# --- Runtime ---
FROM node:20-alpine

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json package-lock.json* .npmrc ./
ARG NPM_TOKEN
RUN echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts --omit=dev && \
    npm cache clean --force && \
    rm -f .npmrc

COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules/@multiagentcoordinationprotocol/proto node_modules/@multiagentcoordinationprotocol/proto
COPY drizzle/ drizzle/

USER appuser

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/main.js"]
