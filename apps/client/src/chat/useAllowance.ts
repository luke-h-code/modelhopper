import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export interface Allowance {
  /** Micro-pounds left this month. Null until the first read lands. */
  remainingMicros: number | null;
  grantMicros: number;
  /** When the allowance goes back to the full grant. */
  resetsAt: Date | null;
  /** True only once a read has proved there is nothing left. */
  exhausted: boolean;
  refresh: () => void;
}

/**
 * What is left of this month's allowance.
 *
 * Read-only and advisory. The Edge Function checks the same balance before it
 * spends anything, and that check is the actual control — this exists so the
 * reader can see the number coming rather than discovering it as a refused
 * message. A client that lied about it would only unlock a composer whose
 * every request the server still refuses.
 */
export function useAllowance(refreshKey: string | null): Allowance {
  const [remainingMicros, setRemaining] = useState<number | null>(null);
  const [grantMicros, setGrant] = useState(0);
  const [resetsAt, setResetsAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;

    void (async () => {
      // The view rather than the RPC: it returns the exchange rate alongside
      // the balance, and the breakdown below needs to convert raw dollar spend
      // at exactly the rate the balance was computed with. RLS on the view
      // returns this user's row and nobody else's.
      const { data, error } = await supabase
        .from("allowance_balance")
        // No exchange rate: both this and the breakdown come back in pounds,
        // converted by the views at the same rate, so nothing on the client
        // needs to know what that rate is.
        .select("budget_micro_gbp, spent_micro_gbp, remaining_micro_gbp, resets_at")
        .maybeSingle();
      if (!live) return;

      if (error) {
        // Left as null rather than zero. An unreadable balance must not look
        // like an empty one: the composer stays usable and the server decides.
        console.error("could not read the allowance:", error.message);
        return;
      }

      if (!data) return;

      setRemaining(Number(data.remaining_micro_gbp ?? 0));
      setGrant(Number(data.budget_micro_gbp ?? 0));
      setResetsAt(data.resets_at ? new Date(data.resets_at) : null);
    })();

    return () => {
      live = false;
    };
  }, [tick, refreshKey]);

  return {
    remainingMicros,
    grantMicros,
    resetsAt,
    exhausted: remainingMicros !== null && remainingMicros <= 0,
    refresh,
  };
}

/** Micro-pounds as money. Pennies below a pound, so small spends stay legible. */
export function formatMicros(micros: number): string {
  const pounds = micros / 1_000_000;
  if (pounds >= 1) return `£${pounds.toFixed(2)}`;
  return `${Math.max(0, Math.round(pounds * 100))}p`;
}

export interface ModelSpend {
  /** Ready to display: a registry name, or "Classifier" for routing calls. */
  model: string;
  calls: number;
  /** Already converted, at the same rate the balance used. */
  costMicroGbp: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * This month's spend, grouped and named, ready to render.
 *
 * Everything that is a rule about the data happens in the `spend_breakdown`
 * view: the grouping, the display names, the classifier masking, and the
 * conversion to pounds at the same rate the balance used. What is left here is
 * formatting, which is genuinely the client's job.
 *
 * `usage_events.model_id` is not readable by `authenticated` at all — which
 * model does the routing stays hidden even from someone reading the network
 * tab — so this view is also the only way to see a breakdown.
 *
 * Fetched only when the panel is opened. Nobody looks at it most days, and the
 * meter above it already has the number that matters.
 */
export async function fetchModelSpend(): Promise<ModelSpend[]> {
  const { data, error } = await supabase
    .from("spend_breakdown")
    .select("model, calls, input_tokens, cached_input_tokens, output_tokens, cost_micro_gbp");

  if (error) {
    console.error("could not read the spend breakdown:", error.message);
    return [];
  }

  // Already grouped, summed, converted and ordered dearest-first by the view.
  return (data ?? []).map((row) => ({
    model: String(row.model ?? ""),
    calls: Number(row.calls ?? 0),
    costMicroGbp: Number(row.cost_micro_gbp ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    cachedInputTokens: Number(row.cached_input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
  }));
}

/**
 * A token count at two significant figures, with a magnitude suffix.
 *
 * 401,400 reads as 400K. The exact number is noise at this size — what the
 * reader is judging is whether a turn cost thousands of tokens or hundreds of
 * thousands, and six digits of precision gets in the way of seeing that.
 * Stops at trillions, which nobody will reach.
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "0";

  // Rounded to two figures BEFORE the unit is chosen, so a number that rounds
  // up past a threshold carries into the right one: 999 becomes 1.0K rather
  // than a four-digit number with no suffix.
  const magnitude = 10 ** (Math.floor(Math.log10(n)) - 1);
  const rounded = Math.round(n / magnitude) * magnitude;

  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];

  for (const [size, suffix] of units) {
    if (rounded >= size) {
      const value = rounded / size;
      // The second significant figure is the tens digit once the mantissa
      // reaches ten, so a decimal place there would be a third.
      return `${value >= 10 ? Math.round(value) : value.toFixed(1)}${suffix}`;
    }
  }

  // Under a thousand the number is short enough to read as it is, and a
  // decimal point on a count of tokens would be nonsense.
  return String(Math.round(rounded));
}
