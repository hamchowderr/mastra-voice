---
paths:
  - "Dockerfile"
  - "docker-compose*.yml"
  - "compose*.yml"
  - "docker/**"
  - ".dockerignore"
---

# Docker

Never change the base image to `node:22-alpine`. `onnxruntime-node` — used by
fastembed embeddings and by LiveKit's Silero VAD and turn detector — ships
glibc-linked prebuilds with no musl build, and `sharp` and the native tokenizers
are the same. The container dies with SIGSEGV. Stay on `node:22-slim`.

Inside compose, never put `127.0.0.1` in a DB URL. Use the service names
(`postgres`, `dolt`), which are already wired.

## The image must ship its models and its CA store

Three faults share one shape: the build succeeds, the image looks fine, and the
worker registers — then every call connects to silence. Do not "fix" any of them
at runtime.

- **Model bakes run with `HOME=/app`.** Both the LiveKit turn detector and
  fastembed resolve their cache from `os.homedir()`, ignoring `HF_HOME`. Under
  the default `HOME=/root` they write outside the tree the runtime stage copies,
  so the build bakes nothing and says nothing. Each bake is followed by a
  `test -f` for exactly that reason — never wrap one in `|| true`.
- **`ca-certificates` is required.** Node carries its own CA bundle, so npm, the
  Anthropic API and the model downloads all work without it — but
  `@livekit/rtc-node` is Rust and reads the OS trust store, so `ctx.connect()`
  fails with `no native root CA certificates found`. `node:22-slim` omits it.
- **Only one `onnxruntime-node` may exist.** Both copies' bindings load a library
  whose SONAME is `libonnxruntime.so.1`, so on Linux the first one loaded wins
  process-wide and the other throws `version VERS_… not found` — inside the job
  subprocess's prewarm, where the rejection is logged at debug and the child
  exits 0. Held to one version by `overrides` in `package.json`.

The `worker` service probes `:8081`, the worker's own health endpoint — not the
server's `:4111/health`, which that container never serves.
