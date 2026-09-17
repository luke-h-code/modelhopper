import { createClient } from "@supabase/supabase-js";

// The client holds exactly two values, both public by design. Every
// authorisation decision is made by Row Level Security in Postgres, not here.
const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  // Thrown at import time, so a deployment missing these is a blank page. The
  // message names both places they can be set, because the one you are not
  // looking at is always the one that is wrong.
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. " +
      "Locally: copy apps/client/.env.example to apps/client/.env. " +
      "On Vercel: set both under Settings > Environment Variables, then " +
      "redeploy — they are read at build time, not at run time.",
  );
}

export const supabase = createClient(url, publishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // OTP code entry rather than a magic link, so there is no redirect to
    // detect and no custom URL scheme to register on desktop or mobile.
    detectSessionInUrl: false,
  },
});

export const FUNCTIONS_URL = `${url}/functions/v1`;
