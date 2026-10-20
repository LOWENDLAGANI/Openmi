import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  });
}

/**
 * GitHub OAuth through Supabase. The `repo` scope is required: the background
 * agent pushes commits with the token minted here.
 */
export async function signInWithGithub(supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      scopes: 'repo read:user',
      redirectTo: `${window.location.origin}/`,
    },
  });
  if (error) throw error;
}
