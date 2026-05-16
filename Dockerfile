# ── Stage 1: compile the C solver ───────────────────────────────
FROM gcc:13-bookworm AS builder

WORKDIR /build
COPY solver/lean25.c .

# -O3 for speed, -march=native for Railway's x86-64
RUN gcc -O3 -march=native -o lean25 lean25.c && \
    strip lean25

# ── Stage 2: Node.js runtime ─────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy compiled solver binary
COPY --from=builder /build/lean25 /app/solver/lean25

# Copy Node.js app
COPY package.json .
RUN npm install --omit=dev

COPY src/ ./src/

# Env defaults (override in Railway dashboard)
ENV NODE_ENV=production \
    SOLVER=/app/solver/lean25 \
    LOG_INTERVAL=5 \
    MAX_GAS_GWEI=30

CMD ["node", "src/index.js"]
