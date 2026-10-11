# Lany API (Elysia on Bun). Render builds this image; PORT is provided by the platform.
FROM oven/bun:1.3-alpine
WORKDIR /app

# Install from the lockfile so the server runs the same package versions as local development.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
USER bun

CMD ["bun", "run", "src/index.ts"]
