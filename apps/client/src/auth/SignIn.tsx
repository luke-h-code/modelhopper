import { useState } from "react";
import { supabase } from "../lib/supabase";

type Stage = "email" | "code";

export default function SignIn() {
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    });

    setBusy(false);
    if (error) setError(error.message);
    else setStage("code");
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    // On success, onAuthStateChange swaps the app in — nothing to do here.
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });

    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <div className="signin-shell flex h-full items-center justify-center p-6">
      <div className="signin-card w-full max-w-md">
        <p className="eyebrow">Secure access</p>
        <h1>Model<span>Hopper</span></h1>
        <p className="signin-lede mt-5 text-ink-soft">
          {stage === "email"
            ? "Sign in with your work email."
            : `We sent a 6-digit code to ${email}.`}
        </p>

        {stage === "email" ? (
          <form onSubmit={requestCode} className="mt-8 space-y-3">
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="field w-full px-4 py-3 text-sm outline-none"
            />
            <button
              type="submit"
              disabled={busy}
              className="primary-button w-full px-4 py-3 text-sm font-semibold disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="mt-8 space-y-3">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="field w-full px-4 py-3 text-center text-lg tracking-[0.3em] outline-none"
            />
            <button
              type="submit"
              disabled={busy}
              className="primary-button w-full px-4 py-3 text-sm font-semibold disabled:opacity-50"
            >
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStage("email");
                setCode("");
                setError(null);
              }}
              className="text-button w-full py-2 text-xs text-ink-soft"
            >
              Use a different email
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className="error-banner mt-4 px-3 py-2 text-sm">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
