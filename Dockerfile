FROM node:20-alpine

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create data directory
RUN mkdir -p data && chown -R node:node /app

# Run as non-root
USER node

# Run migrations and seed on first start
# Data persists via volume mount

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/config || exit 1

CMD ["sh", "-c", "node scripts/migrate.js && node scripts/seed.js && node src/server.js"]
