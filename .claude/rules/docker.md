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
