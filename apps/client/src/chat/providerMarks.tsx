import type { ReactElement } from "react";

/**
 * Provider identity for the badge under an assistant reply.
 *
 * Each provider prefers a real logo from `../assets/providers/<key>.svg` and
 * falls back to the original geometric glyph below when that file is absent,
 * so deleting artwork degrades the badge instead of breaking the build. See
 * that directory's README for where the files come from and what shape they
 * have to be.
 */

/**
 * Logos are read as source text, not as URLs, so the shape can be recoloured
 * per theme — a black mark on a dark background is unreadable, and these are
 * monochrome glyphs meant to be tinted.
 *
 * Parsed once at module load into plain path data and rendered as ordinary
 * React elements. Injecting the file's own markup would be the shorter route
 * and would mean an SVG in this repo could carry anything a future editor put
 * in it; only `viewBox` and `d` survive this.
 */
const LOGO_SOURCES = import.meta.glob("../assets/providers/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

interface LogoShape {
  viewBox: string;
  paths: string[];
}

const LOGOS: Record<string, LogoShape> = {};

for (const [path, source] of Object.entries(LOGO_SOURCES)) {
  const key = path.split("/").at(-1)!.replace(/\.svg$/, "");
  const paths = [...source.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]!);
  if (paths.length === 0) continue;
  LOGOS[key] = {
    viewBox: /viewBox="([^"]+)"/.exec(source)?.[1] ?? "0 0 24 24",
    paths,
  };
}

export interface ProviderMark {
  /** Display name for the badge. */
  label: string;
  /** Tailwind-free inline mark, 14px, inheriting colour from the badge. */
  mark: () => ReactElement;
  /**
   * Colour for the glyph. Monochrome by choice — the badge sits in a row of
   * small grey metadata, and four competing brand colours read as decoration
   * rather than as information.
   */
  tint: string;
}

const svg = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
};

/** The logo for a provider key, or null so the caller can fall back. */
function logoMark(key: string): (() => ReactElement) | null {
  const shape = LOGOS[key];
  if (!shape) return null;

  return function Logo() {
    return (
      <svg {...svg} viewBox={shape.viewBox} fill="currentColor">
        {shape.paths.map((d, i) => <path key={i} d={d} />)}
      </svg>
    );
  };
}

/**
 * Anthropic-served replies. Three strokes converging, echoing the routing
 * diagram used across the marketing page.
 */
function AnthropicMark() {
  return (
    <svg {...svg} fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
      <path d="M5 19 10.5 5" />
      <path d="M13.5 5 19 19" />
      <path d="M9 14.5h6" />
    </svg>
  );
}

/** Meta-served replies: an interlocking loop. */
function MetaMark() {
  return (
    <svg {...svg} fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
      <path d="M4 16c0-6 2.2-9 4.6-9 3.4 0 4.9 10 8.3 10 2 0 3.1-2.4 3.1-5" />
    </svg>
  );
}

/** Google-served replies: an orbit, for the routed query coming back round. */
function GoogleMark() {
  return (
    <svg {...svg} fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
      <ellipse cx="12" cy="12" rx="9" ry="5" transform="rotate(-30 12 12)" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** OpenAI-served replies: a closed hexagonal ring. */
function OpenAIMark() {
  return (
    <svg {...svg} fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinejoin="round">
      <path d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6Z" />
    </svg>
  );
}

/** DeepSeek-served replies: a dive, for the Budget route going deep and cheap. */
function DeepSeekMark() {
  return (
    <svg {...svg} fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
      <path d="M3 7c4.5 0 4.5 5 9 5s4.5-5 9-5" />
      <path d="M7.5 17.5 12 12l4.5 5.5" />
    </svg>
  );
}

/** Anything the router has not been taught yet. */
function GenericMark() {
  return (
    <svg {...svg} fill="none" stroke="currentColor" strokeWidth="2.1">
      <rect x="4.5" y="4.5" width="15" height="15" rx="4.5" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * One ink for every provider. The source SVGs carry their own brand fills,
 * which the loader drops — so this is also what stops a near-black mark from
 * disappearing against the dark theme.
 */
const MONO = "var(--ink-2)";

const PROVIDERS: Record<string, ProviderMark> = {
  anthropic: {
    label: "Anthropic",
    mark: logoMark("anthropic") ?? AnthropicMark,
    tint: MONO,
  },
  meta: { label: "Meta", mark: logoMark("meta") ?? MetaMark, tint: MONO },
  deepseek: {
    label: "DeepSeek",
    mark: logoMark("deepseek") ?? DeepSeekMark,
    tint: MONO,
  },
  google: {
    label: "Google",
    mark: logoMark("google") ?? GoogleMark,
    tint: MONO,
  },
  openai: {
    label: "OpenAI",
    mark: logoMark("openai") ?? OpenAIMark,
    tint: MONO,
  },
};

const FALLBACK: ProviderMark = {
  label: "Model",
  mark: GenericMark,
  tint: MONO,
};

/**
 * Maps a model id to its provider. The Edge Function stores the id it actually
 * called, and both ids are configurable by environment variable, so match on
 * family prefixes rather than an exact list.
 */
export function providerForModel(modelId: string | null): ProviderMark {
  if (!modelId) return FALLBACK;
  const id = modelId.toLowerCase();

  // First, and matched before anything else: DeepInfra serves the model under
  // its full upstream path, so the id carries a vendor prefix the others do
  // not — and a later rule matching a substring of that prefix would badge a
  // Budget reply as somebody else's.
  if (id.includes("deepseek")) return PROVIDERS.deepseek!;
  if (id.includes("claude")) return PROVIDERS.anthropic!;
  if (id.includes("muse") || id.includes("llama")) return PROVIDERS.meta!;
  if (id.includes("gemini")) return PROVIDERS.google!;
  if (id.includes("gpt") || id.includes("luna")) return PROVIDERS.openai!;

  return FALLBACK;
}

/**
 * "claude-sonnet-5" -> "Claude Sonnet 5", "gpt-5.6-luna" -> "GPT 5.6 Luna".
 *
 * Every id is shown in full. There is no override table: a model's codename is
 * part of what it is called, and hiding one would make two different models
 * read as the same name in the badge.
 */
export function modelName(modelId: string | null): string {
  if (!modelId) return "Assistant";

  return modelId
    .split("/").at(-1)!
    // A point release is written with a dash in the id and a dot in the name:
    // "claude-fable-5-1" is Claude Fable 5.1, not Claude Fable 5 1. Only a
    // trailing pair of bare numbers joins, so "gpt-5.6-luna" and
    // "gemini-3.8-flash" — which carry the dot already — are untouched.
    .replace(/-(\d+)-(\d+)$/, "-$1.$2")
    .split("-")
    .map((part) =>
      /^\d/.test(part)
        ? part
        : part.length <= 3
          ? part.toUpperCase()
          : part[0]!.toUpperCase() + part.slice(1),
    )
    .join(" ");
}
