import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadConfig, type Env } from '../env';

/**
 * Service-role Supabase client. Never expose this client or its key to the
 * browser; every query in this codebase is additionally scoped by owner id.
 */
const clients = new Map<string, SupabaseClient>();

export function db(env: Env): SupabaseClient {
  const config = loadConfig(env);
  const cacheKey = `${config.supabaseUrl}|${config.supabaseServiceRoleKey.slice(-12)}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-openmi-runtime': 'worker' },
    },
  });

  clients.set(cacheKey, client);
  return client;
}
