// Allowed browser origins for the /chat function.
//
// Set ALLOWED_ORIGINS as a comma-separated list in production, e.g.
//   supabase secrets set ALLOWED_ORIGINS="https://chat.example.com"
// The "*" fallback exists so local development works out of the box; it is
// deliberately not the production default.
const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = configured.length === 0
    ? "*"
    : origin && configured.includes(origin)
    ? origin
    : configured[0]!;

  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
