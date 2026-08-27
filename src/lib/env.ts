import { z } from 'zod';

const boolish = z
  .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 chars'),

    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_DB_URL: z
      .string()
      .url()
      .refine((v) => v.startsWith('postgres'), 'Must be a postgres:// connection string'),

    // Dolt (versioned business data) — the compose `dolt` service. Optional so
    // the app boots without Dolt; the Dolt tools error clearly if it's missing.
    DOLT_HOST: z.string().optional(),
    DOLT_PORT: z.coerce.number().int().optional(),
    DOLT_USER: z.string().optional(),
    DOLT_PASSWORD: z.string().optional(),
    DOLT_DATABASE: z.string().optional(),

    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),

    // LiveKit — the realtime voice transport. Required: the worker cannot
    // connect without all three, so fail at boot rather than at call time.
    LIVEKIT_URL: z
      .string()
      .url()
      .refine((v) => v.startsWith('ws://') || v.startsWith('wss://'), 'Must be a ws:// or wss:// URL'),
    LIVEKIT_API_KEY: z.string().min(1, 'LIVEKIT_API_KEY required for voice'),
    LIVEKIT_API_SECRET: z.string().min(1, 'LIVEKIT_API_SECRET required for voice'),

    USE_AIMOCK: boolish.default(false),
    AIMOCK_URL: z.string().url().default('http://localhost:4010'),

    E2E_BASE_URL: z.string().url().optional(),

    MASTRA_TELEMETRY_DISABLED: z.string().optional(),
    MASTRA_CLOUD_ACCESS_TOKEN: z.string().optional(),

    // Shared HMAC secret for JWT auth (@mastra/auth). When set, the server
    // gates all /api/* routes AND Studio behind a Bearer JWT signed with this
    // secret. Leave unset for open local dev. Must be HS256-safe (>=32 chars).
    MASTRA_JWT_SECRET: z.string().min(32, 'MASTRA_JWT_SECRET must be at least 32 chars').optional(),
  })
  // The agent's model is an @ai-sdk/anthropic instance (see lib/model.ts), so
  // ANTHROPIC_API_KEY is the one that decides whether a call can produce a reply.
  // Accepting OPENAI_API_KEY alone used to satisfy this check: the process booted,
  // the worker registered, calls connected — and then every turn failed with
  // `401 x-api-key header is required` and the caller heard silence. Fail at boot
  // with a readable message instead of at the first turn with a 401.
  //
  // Under AIMock, configureAIMock() substitutes a placeholder key, so any
  // non-empty value is fine there.
  .refine((e) => Boolean(e.ANTHROPIC_API_KEY) || e.USE_AIMOCK, {
    path: ['ANTHROPIC_API_KEY'],
    message:
      'ANTHROPIC_API_KEY is required — the agent model is an @ai-sdk/anthropic ' +
      'instance, so without it every call answers with silence. Set USE_AIMOCK=true ' +
      'to run against AIMock instead. OPENAI_API_KEY does not substitute for it; ' +
      'it is only used by the answerRelevancy scorer.',
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n');
  for (const [key, errors] of Object.entries(parsed.error.flatten().fieldErrors)) {
    console.error(`  ${key}: ${(errors as string[]).join(', ')}`);
  }
  for (const err of parsed.error.flatten().formErrors) {
    console.error(`  ${err}`);
  }
  console.error('\nSee .env.example for the full list of required variables.');
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
/** @public */
export type Env = typeof env;
