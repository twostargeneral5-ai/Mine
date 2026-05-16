# ── Stage 1: compile the C solver ───────────────────────────────
FROM gcc:13-bookworm AS builder

WORKDIR /build

# Works whether lean25.c is in root or solver/ folder
COPY . .

RUN find . -name "lean25.c" | head -1 | xargs -I{} gcc -O3 -o lean25 {} && \
    strip lean25

# ── Stage 2: Node.js runtime ─────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy compiled binary
COPY --from=builder /build/lean25 /app/lean25

# Copy everything else
COPY . .

RUN npm install --omit=dev

ENV NODE_ENV=production \
    SOLVER=/app/lean25 \
    LOG_INTERVAL=5 \
    MAX_GAS_GWEI=30

# Finds index.js whether it's at root or in src/ folder
CMD sh -c 'node $(find /app -maxdepth 2 -name "index.js" | grep -v node_modules | head -1)'
