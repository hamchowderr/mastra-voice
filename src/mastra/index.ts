// 1. Env validation FIRST — crashes process if misconfigured
import { env } from '../lib/env';

// 2. AIMock provider switch — must run before any AI SDK client constructs
import { configureAIMock } from './lib/aimock';
configureAIMock();

// 3. Mastra imports — agents/tools constructed below now see the right base URLs
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { PostgresStore } from '@mastra/pg';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, SensitiveDataFilter } from '@mastra/observability';
import { MastraEditor } from '@mastra/editor';
import { MCPServer } from '@mastra/mcp';
import { MastraJwtAuth } from '@mastra/auth';
import { voiceAssistantAgent } from './agents/_example';
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
const server = env.MASTRA_JWT_SECRET
  ? { auth: new MastraJwtAuth({ secret: env.MASTRA_JWT_SECRET }) }
  : undefined;

export const mastra = new Mastra({
  ...(server ? { server } : {}),
  agents: { voiceAssistant: voiceAssistantAgent },
  scorers: { answerRelevancyScorer },
  mcpServers: { voiceMcp: mcpServer },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: pgStore,
    editor: pgStore,
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: env.LOG_LEVEL,
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new DefaultExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
  editor: new MastraEditor(),
});
