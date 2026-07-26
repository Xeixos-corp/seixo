import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Points at a Supabase Cloud project during development (see app/.env.example).
// Swap to the self-hosted stack in /supabase before launch — same schema,
// different SUPABASE_URL/ANON_KEY. Supabase (cloud or self-hosted) only ever
// receives ciphertext + opaque channel ids; see docs/threat-model.md.
const env = process.env as Record<string, string | undefined>;
const supabaseUrl = env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. Copy app/.env.example to app/.env and fill in your Supabase project values.',
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
