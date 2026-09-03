# syntax=docker/dockerfile:1.7

# ONE image, TWO services (voice-9jm.11). A voice deployment is two long-running
# processes off the same code: the Mastra HTTP server (+ Studio) and the LiveKit
# worker. This image can run either — the default CMD starts the server; the
# `worker` service in docker-compose.yml overrides the command to start the worker.
# Workers scale by call volume, the server by request volume, so they run as
# separate containers (single-container supervision is demo-only).
#
# Use node:22-slim (Debian/glibc), NOT node:22-alpine (musl).
# onnxruntime-node (fastembed embeddings + LiveKit's Silero VAD and turn-detector),
# sharp, and the native tokenizers all ship glibc-linked prebuilds with no musl
# build — they fail on Alpine even with gcompat. See README "Deployment Notes".
# ─── Stage 1: build ───────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

# node-speaker requires Python + C++ build tools + ALSA headers to compile its native addon
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libasound2-dev && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# onnxruntime-node's postinstall pulls the CUDA/GPU build from api.nuget.org.
# The container has no GPU, and that fetch is a recurring timeout (it broke CI
# three times on 2026-08-26). The CPU runtime ships inside the npm package, and
# fastembed + LiveKit's Silero VAD both use it, so skipping only removes a
# download that would be discarded — and makes consumer builds faster and less
# network-fragile too.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci

COPY . .
# `mastra build` imports the app, and lib/env.ts validates env at import time (it
# THROWS on missing vars). Provide BUILD-TIME stubs so the bundle can be produced.
# These live ONLY in this build stage — the runtime stage is a separate FROM, so
# real values are injected there at runtime via env_file. Nothing secret is baked.
ENV MASTRA_TELEMETRY_DISABLED=1 \
    APP_SECRET=build_time_stub_build_time_stub_32 \
    SUPABASE_URL=https://stub.supabase.co \
    SUPABASE_ANON_KEY=stub \
    SUPABASE_SERVICE_ROLE_KEY=stub \
    SUPABASE_DB_URL=postgres://stub:stub@localhost:5432/stub \
    ANTHROPIC_API_KEY=stub \
    LIVEKIT_URL=wss://stub.livekit.cloud \
    LIVEKIT_API_KEY=stub \
    LIVEKIT_API_SECRET=stub
# --studio bundles the Studio SPA so it can be served self-hosted in production.
RUN npx mastra build --studio
# Bake Studio config: auto-detect server from same origin → no "enter URL" form,
# works for any deploy domain with no per-deploy config.
RUN node scripts/bake-studio.mjs

# Bake LiveKit model files so worker cold starts don't fetch them mid-connect.
# Silero VAD ships INSIDE @livekit/agents-plugin-silero (node_modules), so it's
# already baked; this fetches the turn-detector model into HF_HOME. Best-effort:
# the standalone CLI only downloads for plugins it can register, so if it fetches
# nothing the worker pulls the model once on first cold start (then it's cached).
ENV HF_HOME=/app/.cache/huggingface
# HOME is overridden for this step on purpose. The turn-detector downloader
# ignores HF_HOME and writes to $HOME/.cache/huggingface. With the default
# HOME=/root the model lands in /root, which is never copied into the runtime
# stage, so the image registers a worker that cannot serve a call. HOME=/app
# makes that path resolve to exactly HF_HOME (/app/.cache/huggingface), which IS
# copied — do not set it to /app/.cache or the path doubles to .cache/.cache.
RUN mkdir -p "$HF_HOME" && \
    (HOME=/app npx livekit-agents download-files || \
     echo "download-files: nothing baked — worker will fetch on first cold start")

# Bake the fastembed embedding model (~133MB) the same way. Memory's semantic
# recall embeds on every turn, so without it the FIRST call downloads it mid-call
# — and that first embed loses the race against its own download, failing with
# `Tokenizer file not found at .../fast-bge-small-en-v1.5/tokenizer.json`. It
# lands in /app/.cache/mastra, which the runtime stage copies alongside the
# LiveKit models. NO `|| true` here: a swallowed failure is what ships a broken
# image, so let the build fail instead.
#
# HOME=/app for the same reason as the step above — fastembed resolves its cache
# as `os.homedir()/.cache/mastra/fastembed-models`, so with the default
# HOME=/root the model lands outside the tree the runtime stage copies and the
# build "succeeds" having baked nothing.
RUN HOME=/app node --input-type=module -e "const { warmup } = await import('@mastra/fastembed'); await warmup();" && \
    test -f /app/.cache/mastra/fastembed-models/fast-bge-small-en-v1.5/tokenizer.json

# Drop devDependencies (mastra CLI, typescript, types) AFTER the build: the runtime
# server runs the built bundle and the worker runs from source via tsx (a PRODUCTION
# dependency, self-contained — it needs neither the mastra CLI nor the typescript pkg).
RUN npm prune --omit=dev

# onnxruntime-node ships prebuilt binaries for EVERY platform inside a single
# package (bin/napi-v6/{darwin,linux,win32}/{arm64,x64}), so npm's
# optionalDependencies pruning — which is what keeps @esbuild, @rollup and @img
# down to one platform — cannot touch it. In a Linux image the macOS and Windows
# copies can never be loaded:
#
#   darwin/arm64  72.3 MB      linux/x64    35.9 MB   <- used
#   win32/arm64   65.9 MB      linux/arm64  19.0 MB   <- kept for arm64 builds
#   win32/x64     60.7 MB
#
# That is ~199 MB of unloadable binaries, and the image carries the package
# TWICE — once in the server bundle that `mastra build` installs, once in the
# worker's tree — so removing them saves roughly 400 MB.
#
# linux/arm64 is deliberately kept so this same Dockerfile still produces a
# working image when built for arm64.
#
# These are the only two paths worth deleting because `overrides` in package.json
# holds onnxruntime-node to ONE version, so npm hoists a single copy per tree. If
# that pin is ever dropped, a nested copy reappears (under @mastra/fastembed) and
# this step silently stops covering it — which matters for far more than size.
RUN rm -rf       node_modules/onnxruntime-node/bin/napi-v6/darwin       node_modules/onnxruntime-node/bin/napi-v6/win32       .mastra/output/node_modules/onnxruntime-node/bin/napi-v6/darwin       .mastra/output/node_modules/onnxruntime-node/bin/napi-v6/win32

# ─── Stage 2: runtime base ────────────────────────────────────────
# Everything both leaf stages need. It sets no CMD of its own — the two stages
# below are identical images that differ only in which process they start.
FROM node:22-slim AS runtime-base
WORKDIR /app

# tini — proper signal handling for SIGTERM
# node:22-slim is Debian-based (glibc), so no gcompat needed for native modules (onnxruntime, sharp)
#
# ca-certificates is NOT optional here, and its absence is invisible until a call
# arrives. Node carries its own bundled CA store, so npm, the Anthropic API and
# the model download all work without it — but @livekit/rtc-node is Rust and
# reads the OS trust store, so `ctx.connect()` dies with
# `no native root CA certificates found` and the caller waits in silence while
# the worker keeps reporting itself healthy. node:22-slim ships without it.
RUN apt-get update && apt-get install -y --no-install-recommends tini wget ca-certificates && rm -rf /var/lib/apt/lists/*

# `-m` (create the home directory), NOT `-M`. @livekit/agents' download-files
# writes the turn-detector model under $HOME and ignores HF_HOME for that step,
# so a user with no home directory fails with
# `EACCES: permission denied, mkdir '/home/mastra'`. That failure is swallowed by
# the `|| echo` on the bake step above, so the image builds green and ships
# without the model; the worker then refetches it on the first cold start, on the
# caller's clock, and needs network egress to do it.
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/sh -m -d /home/mastra mastra && \
    chown -R mastra:nodejs /app /home/mastra

ENV NODE_ENV=production
ENV PORT=4111
# Shared by both processes: fastembed resolves its model cache as
# `os.homedir()/.cache/mastra/fastembed-models`, so HOME must match the HOME used
# for the bake in the build stage. A cold-start refetch needs it writable too.
# MASTRA_STUDIO_PATH and HF_HOME are NOT here — each points into a directory only
# one leaf stage carries, so they are set there.
ENV HOME=/app

# Baked fastembed model (~133MB tree) — the ONLY payload both processes need, so
# it lives here as one shared layer. Memory's semantic recall embeds on both the
# text path and the voice path, and fastembed resolves it as
# `os.homedir()/.cache/mastra/fastembed-models` — HOME=/app above makes that land
# here. The turn detector is NOT here: it is worker-only and lives in the agent
# stage. (Silero VAD is in neither; it ships inside node_modules.)
COPY --from=build --chown=mastra:nodejs /app/.cache/mastra ./.cache/mastra

USER mastra
ENTRYPOINT ["/usr/bin/tini", "--"]

# Each leaf stage below copies ONLY the runtime it executes. That is deliberate:
# the two processes share nothing but the models above. The server runs a bundle
# that carries its own node_modules and its own package.json (`"type": "module"`,
# name "server"), so it needs nothing from the repo root; the worker runs from
# source under tsx and never loads the bundle. Copying both into a shared base
# put ~600 MB of server bundle in the worker image and ~840 MB of worker tree in
# the server image, and neither could ever execute the other's half.

# ─── Stage 3: agent — one container, one LiveKit worker ───────────
# For LiveKit Cloud Agents (`lk agent create --image …`), which runs ONE process
# per container and can't override a command the way compose does. It shares the
# base and the baked models with the runtime stage; everything below is the
# worker's own runtime, which the server image never carries.
#
# NOT the default target. `runtime` stays last so a bare `docker build .` still
# produces the server; ask for this one with `--target agent`. Compose and CI now
# name their target explicitly, because neither image can run the other's process
# any more. `lk agent create` has no --target flag, which is exactly why the
# README builds this locally and hands LiveKit the finished image.
FROM runtime-base AS agent
# Runs from SOURCE via tsx — deliberately NOT bundled, because bundling would drag
# in LiveKit's native deps (onnxruntime, …). Needs the production node_modules, the
# source tree, and the manifest/tsconfig. Does NOT need .mastra/output.
COPY --from=build --chown=mastra:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=mastra:nodejs /app/src ./src
COPY --from=build --chown=mastra:nodejs /app/package.json ./package.json
COPY --from=build --chown=mastra:nodejs /app/tsconfig.json ./tsconfig.json
# Where the baked turn-detector model lives (must match the build stage). The
# downloader resolves $HOME/.cache/huggingface, which HOME=/app makes identical.
ENV HF_HOME=/app/.cache/huggingface
# The baked turn-detector model (~441MB), resolved through HF_HOME. It belongs to
# THIS stage alone: end-of-turn detection runs only in the worker, and the server
# never constructs a TurnDetector because nothing it loads imports voice-worker.ts.
# Shipping it to the server would be 441MB that can never be read.
COPY --from=build --chown=mastra:nodejs /app/.cache/huggingface ./.cache/huggingface
# @livekit/agents serves its health endpoint on 8081 in production mode (`start`),
# never on 4111 — so the inherited server healthcheck would fail forever. Replace
# it. 503 here means `inference process not running`: the shared turn-detector
# subprocess died and every later call will sit in silence. See README
# "Known limitations".
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8081/ > /dev/null 2>&1 || exit 1
CMD ["node", "--import", "tsx", "src/mastra/voice-worker.ts", "start"]

# ─── Stage 4: runtime — the DEFAULT target ────────────────────────
# Last stage on purpose: it is what `docker build` produces with no --target.
FROM runtime-base AS runtime
# Serve the bundled Studio UI (chat, traces, editor) from the same server.
# Secure it behind auth before exposing publicly (see Mastra Studio auth docs).
ENV MASTRA_STUDIO_PATH=/app/.mastra/output/studio
# The self-contained Mastra HTTP service. `mastra build` emits its own
# node_modules, package.json and lockfile in here, so this single COPY is the
# whole server — no repo-root node_modules, no src, no tsconfig.
COPY --from=build --chown=mastra:nodejs /app/.mastra/output ./.mastra/output
EXPOSE 4111
# Server-only healthcheck (the worker has no HTTP port; its compose service overrides it).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4111/health > /dev/null 2>&1 || exit 1
# Default service = Mastra HTTP server. The `worker` service in docker-compose.yml
# overrides this with:  node --import tsx src/mastra/voice-worker.ts start
CMD ["node", ".mastra/output/index.mjs"]
