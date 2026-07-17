// 1. Env validation FIRST — crashes process if misconfigured
import { env } from '../lib/env';

// 2. AIMock provider switch — must run before any AI SDK client constructs
import { configureAIMock } from './lib/aimock';
configureAIMock();

// 3. Mastra imports — agents/tools constructed below now see the right base URLs
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { PostgresStore } from '@mastra/pg';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, SensitiveDataFilter, MastraPlatformExporter } from '@mastra/observability';
import { MastraEditor } from '@mastra/editor';
import { MCPServer } from '@mastra/mcp';
import { MastraJwtAuth } from '@mastra/auth';
import { liveKitConnectionRoute } from '@mastra/livekit';
import { voiceAssistantAgent } from './agents/_example';
import { VOICE_AGENT_NAME } from './lib/voice';
import { answerRelevancyScorer } from './scorers/_example.scorers';
import { doltTools } from './tools/dolt';
import { ensureDatabase, doltConfigured } from './lib/dolt';

// Bootstrap the versioned Dolt database on first boot (no-op if Dolt isn't configured).
if (doltConfigured) {
  await ensureDatabase();
}

const mcpServer = new MCPServer({
  id: 'voice-mcp',
  name: 'template-mastra-voice',
  version: '0.1.0',
  description: 'MCP server exposing template-mastra-voice agents + Dolt tools',
  // Dolt versioned-data tools exposed over MCP. To let the voice agent call
  // them directly, spread `...doltTools` into the agent's own `tools`.
  tools: { ...doltTools },
  agents: { voiceAssistant: voiceAssistantAgent },
});

// One shared Postgres store for both default + editor slots. Two separate
// instances on the same DB race on first boot creating shared types
// (mastra_ai_spans) -> 23505. Sharing one instance avoids it.
const pgStore = new PostgresStore({ id: 'mastra-storage', connectionString: env.SUPABASE_DB_URL });

// JWT auth: when MASTRA_JWT_SECRET is set, gate all /api/* routes AND Studio
// behind a Bearer JWT signed with the shared secret. `/health` and `/api/auth/*`
// stay public (so healthchecks and the Studio login screen still work). Leave
// the secret unset for open local dev. Shared-secret only — no external provider.
const server = {
  // Mints a LiveKit room token so a frontend can join the call. Served at
  // /voice/livekit/connection-details — NOT under /api, which Mastra reserves for
  // its own built-ins, so a custom path starting with /api is rejected.
  //
  // AUTH POSTURE (deliberate — do not "fix" this to false):
  // `requiresAuth` defaults to true and we keep it. The route sits outside the
  // /api/* prefix that MastraJwtAuth gates, but requiresAuth still applies Mastra's
  // auth to it, so the two line up: with MASTRA_JWT_SECRET set, this route needs
  // the same Bearer JWT as the rest of the server; with it unset (open local dev)
  // the whole server is open and so is this. The shipped LiveKit example sets
  // requiresAuth:false and says "local demo only — protect this route in
  // production"; this template is published and degit-able, so it ships the safe
  // posture instead. An unauthenticated route here mints LiveKit tokens for
  // anyone, letting strangers join rooms and burn your LiveKit minutes.
  //
  // SECURITY, NOT YET DONE (voice-9jm.15): the default `metadata` passes
  // agentId/threadId/resourceId straight through from the POST body, so an
  // authenticated caller can still name someone else's resourceId and read their
  // memory — an IDOR on the memory store. Derive resourceId from the verified JWT
  // subject and mint threadId server-side before this is exposed to real users.
  apiRoutes: [liveKitConnectionRoute({ agentName: VOICE_AGENT_NAME })],
  ...(env.MASTRA_JWT_SECRET
    ? { auth: new MastraJwtAuth({ secret: env.MASTRA_JWT_SECRET }) }
    : {}),
};

export const mastra = new Mastra({
  server,
  agents: { voiceAssistant: voiceAssistantAgent },
  scorers: { answerRelevancyScorer },
  mcpServers: { voiceMcp: mcpServer },
  // Postgres serves every slot. Observability deliberately has no `domains`
  // override: it falls through to `default`, reusing the ONE pgStore instance
  // above. Do not give it its own store — a single-writer store (DuckDB) cannot
  // serve the two-process model, since the LiveKit worker writes spans for every
  // voice turn from a separate process (and its job subprocesses from more).
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: pgStore,
    editor: pgStore,
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: env.LOG_LEVEL,
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        // Local traces always; also ship to hosted Mastra Observe when creds are set
        // (MASTRA_PLATFORM_ACCESS_TOKEN + MASTRA_PROJECT_ID) — no-op otherwise.
        exporters: [
          new DefaultExporter(),
          ...(process.env.MASTRA_PLATFORM_ACCESS_TOKEN && process.env.MASTRA_PROJECT_ID
            ? [new MastraPlatformExporter()]
            : []),
        ],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
  editor: new MastraEditor(),
});
