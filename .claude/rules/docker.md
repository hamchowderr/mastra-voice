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
  the default `HOME=/root` they write outside the tree the runtime stages copy,
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

## Two leaf stages, and `target` is load-bearing

One Dockerfile, two images. `runtime-base` carries the Debian base, tini, the
non-root user, and the fastembed model — the only payload both processes read.
Each leaf then copies **only the runtime it executes**:

| Stage | Carries | Runs |
| --- | --- | --- |
| `agent` | `node_modules`, `src`, manifests, the turn-detector model | the LiveKit worker |
| `runtime` (default) | `.mastra/output` | the Mastra HTTP server |

Consequences, all of which have bitten before in the single-image form:

- **Never give a compose service the wrong `target`, and never omit it.** It is
  not a safety net any more, it decides what is in the image. A service on
  `runtime` cannot start the worker (no `src/`), and one on `agent` cannot start
  the server (no `.mastra/output`).
- **Never re-add a `command:` override to the `worker` service.** The `agent`
  stage's own `CMD` is the worker, deliberately: LiveKit Cloud Agents runs one
  process per container and cannot override a command, so the image has to be
  correct on its own. Compose using the same image is what keeps CI honest about
  that.
- **Never move a leaf's `COPY` up into `runtime-base` to "share a layer".** That
  is what put ~600 MB of server bundle in the worker image and ~841 MB of worker
  tree plus the 441 MB turn detector in the server image. Sharing costs nothing
  here — a host running both pulls the same bytes either way.
- **`HF_HOME` belongs to `agent`, `MASTRA_STUDIO_PATH` to `runtime`.** Each names
  a directory only that stage carries. Setting either in the base makes the env
  point at nothing in the other image.
- **`runtime` stays the LAST stage** so a bare `docker build .` still produces the
  server. CI and compose name their target explicitly regardless.
