import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Points at a Supabase Cloud project during development (see app/.env.example).
// Swap to the self-hosted stack in /supabase before launch — same schema,
// different SUPABASE_URL/ANON_KEY. Supabase (cloud or self-hosted) only ever
// receives ciphertext + opaque channel ids; see docs/threat-model.md.
// Read these as direct `process.env.NAME` member expressions and nothing
// else. Expo substitutes EXPO_PUBLIC_* at *build* time by static text
// replacement, so any indirection defeats it -- an earlier version of this
// file did `const env = process.env` and then `env.EXPO_PUBLIC_SUPABASE_URL`,
// which never got substituted. That was invisible in the dev client (where
// process.env is populated at runtime from app/.env) and shipped a
// production bundle where both values were undefined: the throw below fired
// during module import, React never mounted, and the TestFlight build showed
// a blank white screen with no error. Verified by grepping main.jsbundle
// inside the built .ipa -- the only occurrence of the variable name was the
// error message itself. See docs/threat-model.md.
// @ts-expect-error -- see the note above: these must stay bare
// `process.env.NAME` member expressions. TypeScript doesn't know about them
// (this project's ambient typings give process.env no index signature), but
// adding a cast to satisfy it is exactly what breaks the build: verified by
// running `npx expo export --platform ios` on both forms and grepping the
// output bundle -- the bare form inlines the real value, and
// `(process.env as Record<string, string | undefined>).EXPO_PUBLIC_...`
// does not, because Babel's substitution runs before TypeScript's types are
// stripped and no longer matches. If a future Expo/TypeScript version types
// these properly, this directive will start failing as unused -- delete it
// then, don't work around it.
const supabaseUrl: string | undefined = process.env.EXPO_PUBLIC_SUPABASE_URL;
// @ts-expect-error -- same as above.
const supabaseAnonKey: string | undefined = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Locally: copy app/.env.example to app/.env and fill in your Supabase project values. ' +
      'For EAS builds these come from the EAS environment instead (eas env:set ... --environment production) ' +
      'and are inlined at build time -- see the Tier 3 section of the root README.',
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
