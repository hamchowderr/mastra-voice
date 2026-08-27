<!--
Maintainer notes (stripped before this file enters Claude's context, so they
cost nothing):

- Audience is someone who CLONED this template, not the upstream maintainer.
  Keep personal workflow (beads, session-close, push protocol) out of here.
- Detailed conventions live in .claude/rules/*.md as path-scoped rules, so they
  load only when Claude opens a matching file. AGENTS.md carries the same
  material in narrative form for agents that don't read .claude/rules/
  (Cursor, Copilot). The two are separate files — when you change a
  convention, change both.
- Target under 200 lines. Per line, ask: would removing this cause a mistake?
- Run /doctor after editing; it proposes cuts for anything derivable from code.
-->

# Project Instructions for AI Agents

`mastra-voice` is a template: a Mastra voice agent that answers phone and browser
calls over LiveKit, with AI disclosure, consent capture, and a per-call audit
ledger built in. Most people reading this file arrived by cloning it to build
their own agent — treat the repo as a starting point to modify, not a library to
consume.

## Two processes, not one

The HTTP server (`npm run dev`) owns the text path and Studio on `:4111`. The
LiveKit worker (`npm run worker:dev`) owns the audio loop in a separate process,
runs from source via `tsx`, and is not bundled by `mastra build`. A change to an
agent affects both. When a call connects to silence, the worker is the thing
that isn't running.

## Check the setup before running anything

A fresh clone is not runnable until all of these are true. Verify rather than
assume — nearly every first-run failure is one of them, and the error doesn't
always name the cause.

1. **`.env` exists** — `cp .env.example .env`. Boot validates the whole schema in
   `src/lib/env.ts` and exits 1 listing each missing key.
2. **`LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are set even for
   text-only work.** The schema requires them, so the HTTP server will not boot
   without them whether or not you touch audio.
3. **`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set.**
4. **Local Supabase is up** — `npx supabase start`, which needs Docker. Without
   it, storage fails with `ECONNREFUSED 127.0.0.1:54322`.
5. **Node is 22.13+**, per `engines` in `package.json`.
6. **The worker has its model files** — `npm run worker:download-files`, once,
   before the worker's first run. Silero VAD already ships in `node_modules`;
   the turn detector does not.

When a precondition is missing, say so and stop. Do not work around it with a
mock, a hardcoded value, or a `try`/`catch`.

## Verify before calling anything done

There is no vitest and no playwright here. These two commands are the entire
gate:

```bash
npm run typecheck    # tsc --noEmit
npm run eval         # all eval cases in text mode; exits 0 on pass, 1 on fail
```

Run `npm run typecheck` after a series of edits and fix what it reports — an
agent must pass it before being registered in `src/mastra/index.ts`. Show the
command output rather than asserting that it passed.

## Spending the user's money is the user's call

`npm run eval` hits the real Anthropic API and bills the key in `.env`. That is
the default path, because `USE_AIMOCK` defaults to `false`. Ask before running
a paid eval.

For a free deterministic run, start AIMock first — it is a separate binary, not
a dependency of this project:

```bash
npx -y -p @copilotkit/aimock aimock -c aimock.json   # terminal 1
USE_AIMOCK=true npm run eval                         # terminal 2
```

**IMPORTANT: never collapse `src/mastra/lib/model.ts` into a module-scope
constant.** It bakes in the real Anthropic endpoint before `configureAIMock()`
can rewrite it, and every eval afterwards silently bills the user instead of
hitting the mock.

## Repository etiquette

Branch off `main` as `feature/`, `fix/`, or `chore/` — never commit to `main`
directly. Run the two gate commands above before opening a PR.

## Task tracking

Use whatever your host provides. This repo ships no tracker of its own —
`.beads/` and `.claude/settings.json` are gitignored, so none of that state
survives a clone.

## Never commit

`.env`, API keys, LiveKit secrets, `APP_SECRET`, or a caller's phone number.
`.env.example` carries placeholders only, and a new env var belongs in the Zod
schema and `.env.example` in the same change.

## Skills

`.claude/skills/` ships `mastra`, `livekit-agents`, and `livekit-simulations`,
committed to the repo — `git clone` is the whole install. Read the **Skills**
section of [`AGENTS.md`](AGENTS.md) before following `livekit-agents`: it is
written for LiveKit Cloud and parts of it do not apply to this stack.

## Everything else

Conventions for a given file load automatically from `.claude/rules/` when you
open it. [`AGENTS.md`](AGENTS.md) holds the same material as one narrative, and
build and run commands are in the [README](README.md).
