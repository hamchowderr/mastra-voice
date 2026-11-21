import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../lib/env';

let anonClient: SupabaseClient | null = null;
let serviceClient: SupabaseClient | null = null;

/**
 * Anon Supabase client — respects Row-Level Security policies.
 *
 * Use this when the agent acts on behalf of a user and you want
 * RLS to enforce who can read/write what.
 */
export function getSupabaseAnon(): SupabaseClient {
  if (!anonClient) {
    anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return anonClient;
}

/**
 * Service-role Supabase client — bypasses Row-Level Security.
 *
 * Use for system-level operations: background jobs, admin tooling,
 * ingestion pipelines. NEVER expose this client or its results
 * directly to a user-controlled context.
 */
export function getSupabaseService(): SupabaseClient {
  if (!serviceClient) {
    serviceClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceClient;
}

/**
 * Returns an anon client scoped to a specific user's JWT.
 * RLS evaluates as that user, not as the anon role.
 */
export function getSupabaseForUser(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
