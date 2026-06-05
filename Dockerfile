# Stage 1: Install dependencies using node (for network/registry compatibility & stability)
FROM node:20-slim AS builder
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

# Stage 2: Run with Bun
FROM oven/bun:1.2-alpine AS runner
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY ./src ./src

ENV PORT=3000
ENV IS_DOCKER=true
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
