# Worker image (TRD §13.2 "worker-*" tasks): scraper, outbox indexer and scan pipeline.
# Build from the repo root:  docker build -f apps/worker/Dockerfile -t lawassist-worker .
# Test stage (real qpdf/Poppler): docker build -f apps/worker/Dockerfile --target test .
FROM node:22-bookworm-slim AS base
# Scan pipeline tools (TRD §8.2, §12.6): qpdf sanitizes PDFs; Poppler extracts text and rasterizes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends qpdf poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Dependencies first, for layer caching: workspace manifests + lockfile only.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
COPY apps/api/package.json apps/api/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/legal-text/package.json packages/legal-text/
COPY packages/providers/package.json packages/providers/
RUN pnpm install --frozen-lockfile

# Real-binary tests (tools.real.test.ts) run here; the qpdf/Poppler tests are skipped elsewhere.
FROM deps AS test
COPY . .
RUN REQUIRE_DOC_TOOLS=1 pnpm exec vitest run --project unit apps/worker/test/tools.real.test.ts

FROM deps AS runtime
COPY tsconfig*.json ./
COPY packages packages
COPY apps/worker apps/worker
ENV NODE_ENV=production
USER node
WORKDIR /app/apps/worker
# Run tsx directly: invoking pnpm at runtime would re-check (and try to rewrite) node_modules.
CMD ["/app/node_modules/.bin/tsx", "src/main.ts"]
