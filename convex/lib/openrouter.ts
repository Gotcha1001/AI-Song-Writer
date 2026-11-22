// convex/lib/openrouter.ts
// One place that talks to the AI, used by the song writer AND the melody
// composer. It tries several models in turn until one answers:
//   1. OpenRouter models (free ones by default), then
//   2. Gemini models (if GEMINI_API_KEY is set).
// (Kept out of ai.ts because "use node" files may only export actions.)
//
// Env (set with `npx convex env set NAME value`):
//   OPENROUTER_API_KEY   OpenRouter key (optional if GEMINI_API_KEY is set)
//   GEMINI_API_KEY       Google AI Studio key (optional if OPENROUTER_API_KEY is set)
//   OPENROUTER_MODELS    optional, comma separated, tried BEFORE the defaults
//   GEMINI_MODELS        optional, comma separated, tried BEFORE the defaults
//   AI_PRIMARY           optional, "gemini" to try Gemini before OpenRouter

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Tried in order (after anything in OPENROUTER_MODELS). Free slugs churn
 * constantly (llama-3.3-70b and nemotron-3-super are no longer served for
 * free), so keep this list short: "openrouter/free" is OpenRouter's own router
 * that picks a currently-live free model, and is the safety net at the end.
 * Put today's exact free slugs (https://openrouter.ai/collections/free-models)
 * in OPENROUTER_MODELS instead of editing this list.
 *
 * Non-reasoning models go FIRST: reasoning models can spend the whole token
 * budget on thinking and return nothing, so they are last resorts.
 */
const DEFAULT_OPENROUTER_MODELS: readonly string[] = [
  "google/gemma-4-31b-it:free",
  "openrouter/free",
];

let warnedNoGemini = false;

/** Stable Gemini models (the newest releases get "high demand" 503 spikes). */
const DEFAULT_GEMINI_MODELS: readonly string[] = [
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
];

const MAX_OPENROUTER_MODELS = 5;
const MAX_GEMINI_MODELS = 4;
// ai.ts retries up to 3 times and a Convex action may run for 10 minutes, so
// one callModel() has to finish well inside a third of that.
const DEFAULT_ATTEMPT_TIMEOUT_MS = 80_000; // ONE model
const DEFAULT_TOTAL_TIMEOUT_MS = 170_000; // all models together
const MIN_ATTEMPT_WINDOW_MS = 5_000; // don't start a call with less time left
const DEAD_MODEL_TTL_MS = 10 * 60 * 1000; // how long a "gone" model is skipped
const OVERLOADED_TTL_MS = 2 * 60 * 1000; // how long a 5xx model is skipped

export type ReasoningEffort = "low" | "medium" | "high";

export class ModelError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Provider = "openrouter" | "gemini";

interface Attempt {
  provider: Provider;
  model: string;
}

type FailKind =
  | "auth"
  | "gone"
  | "rate_limited"
  | "overloaded" // 500 / 502 / 503 / 504
  | "timeout"
  | "error";

/** One model failed in a way that means "try the next one". */
class AttemptError extends Error {
  constructor(
    message: string,
    readonly kind: FailKind,
  ) {
    super(message);
  }
}

/* ------------------------------- helpers ------------------------------- */

function isServerBusy(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "")) // tolerate quoted values
    .filter(Boolean);
}

/** Things people paste in as stand-ins and forget to replace. */
const PLACEHOLDER_RE =
  /^(slug[a-z0-9_-]*|model[-_ ]?id|your[-_ ].*|<.*>|\[.*\]|example.*|todo|tbd|changeme|none|null|undefined|x{2,})$/i;

/** OpenRouter ids look like "vendor/model-name" or "vendor/model-name:free". */
function isValidOpenRouterId(id: string): boolean {
  if (PLACEHOLDER_RE.test(id)) return false;
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(id);
}

/** Gemini ids look like "gemini-3.5-flash". */
function isValidGeminiId(id: string): boolean {
  if (PLACEHOLDER_RE.test(id)) return false;
  return /^(gemini|gemma)-[a-z0-9][a-z0-9._-]*$/i.test(id);
}

const warnedBadIds = new Set<string>();

function cleanList(
  provider: Provider,
  ids: string[],
  isValid: (id: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (isValid(id)) {
      out.push(id);
    } else if (!warnedBadIds.has(`${provider}:${id}`)) {
      warnedBadIds.add(`${provider}:${id}`);
      console.error(
        `[ai] IGNORING invalid ${provider} model id "${id}" (placeholder or malformed). ` +
          `Fix it with: npx convex env set ${
            provider === "openrouter" ? "OPENROUTER_MODELS" : "GEMINI_MODELS"
          } "<real-id>,<real-id>"  (or remove it to use the defaults).`,
      );
    }
  }
  return out;
}

/* Models that failed "gone"/"overloaded" recently are skipped while this isolate is warm. */
const deadCache = new Map<string, { at: number; ttl: number }>();

function markDead(id: string, ttl: number = DEAD_MODEL_TTL_MS): void {
  deadCache.set(id, { at: Date.now(), ttl });
}

function isDeadCached(id: string): boolean {
  const entry = deadCache.get(id);
  if (!entry) return false;
  if (Date.now() - entry.at > entry.ttl) {
    deadCache.delete(id);
    return false;
  }
  return true;
}

function getOpenRouterModels(first?: string): string[] {
  const fromEnv = [
    ...parseList(process.env.OPENROUTER_MODELS),
    ...parseList(process.env.OPENROUTER_MODEL),
  ];
  // Env ids go first, defaults are ALWAYS appended as backup.
  const merged = [
    ...(first ? [first] : []),
    ...fromEnv,
    ...DEFAULT_OPENROUTER_MODELS,
  ];
  return cleanList(
    "openrouter",
    Array.from(new Set(merged)),
    isValidOpenRouterId,
  ).slice(0, MAX_OPENROUTER_MODELS);
}

function getGeminiModels(): string[] {
  const fromEnv = [
    ...parseList(process.env.GEMINI_MODELS),
    ...parseList(process.env.GEMINI_MODEL),
  ];
  const merged = [...fromEnv, ...DEFAULT_GEMINI_MODELS];
  return cleanList(
    "gemini",
    Array.from(new Set(merged)),
    isValidGeminiId,
  ).slice(0, MAX_GEMINI_MODELS);
}

function buildAttempts(
  hasOpenRouter: boolean,
  hasGemini: boolean,
  firstModel?: string,
): Attempt[] {
  const openrouter: Attempt[] = hasOpenRouter
    ? getOpenRouterModels(firstModel).map((model) => ({
        provider: "openrouter" as const,
        model,
      }))
    : [];
  const gemini: Attempt[] = hasGemini
    ? getGeminiModels().map((model) => ({
        provider: "gemini" as const,
        model,
      }))
    : [];
  const geminiFirst =
    (process.env.AI_PRIMARY ?? "").trim().toLowerCase() === "gemini";
  const all = geminiFirst
    ? [...gemini, ...openrouter]
    : [...openrouter, ...gemini];

  // Skip recently-dead models, but never end up with nothing to try.
  const alive = all.filter((a) => !isDeadCached(`${a.provider}:${a.model}`));
  return alive.length > 0 ? alive : all;
}

/* ------------------------------ OpenRouter ----------------------------- */

interface OpenRouterResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  error?: { message?: string; code?: number };
}

/** HTTP 400s that really mean "this model id doesn't exist / can't be used". */
const OPENROUTER_BAD_MODEL_RE =
  /not a valid model|invalid model|unknown model|no endpoints found|model .*(not found|not available|does not exist)/i;

interface Resolved {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  effort: ReasoningEffort;
  title: string;
  label: string;
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  o: Resolved,
  timeoutMs: number,
): Promise<string> {
  const tag = `[openrouter:${o.label}]`;
  const startedAt = Date.now();
  console.log(`${tag} request`, { model, maxTokens: o.maxTokens });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = () =>
    new AttemptError(
      `${model}: no answer within ${Math.round(timeoutMs / 1000)}s`,
      "timeout",
    );

  try {
    let res: Response;
    let text: string;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Title": o.title,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: o.system },
            { role: "user", content: o.user },
          ],
          temperature: o.temperature,
          // Reasoning models spend tokens thinking first, so leave room.
          max_tokens: o.maxTokens,
          // "low" keeps them from burning the whole budget on thinking.
          reasoning: { effort: o.effort },
        }),
      });
      text = await res.text();
    } catch (e: unknown) {
      if (controller.signal.aborted) throw timedOut();
      throw new AttemptError(
        `${model}: network error ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }

    let json: OpenRouterResponse | null = null;
    try {
      json = JSON.parse(text) as OpenRouterResponse;
    } catch {
      json = null;
    }

    // OpenRouter sometimes answers HTTP 200 with an error in the body.
    const status = !res.ok ? res.status : (json?.error?.code ?? 0);
    if (!res.ok || json?.error || !json) {
      const detail = (json?.error?.message ?? text).slice(0, 300);
      const message = `OpenRouter ${res.status || status} (${model}): ${detail}`;
      console.error(`${tag} error`, {
        model,
        status,
        body: text.slice(0, 500),
      });
      if (status === 401) throw new AttemptError(message, "auth");
      if (status === 404 || status === 403 || status === 410) {
        throw new AttemptError(message, "gone");
      }
      if (status === 400 && OPENROUTER_BAD_MODEL_RE.test(text)) {
        throw new AttemptError(message, "gone");
      }
      if (status === 429 || status === 402) {
        throw new AttemptError(message, "rate_limited");
      }
      if (isServerBusy(status)) throw new AttemptError(message, "overloaded");
      throw new AttemptError(message, "error");
    }

    const choice = json.choices?.[0];
    const content = choice?.message?.content?.trim();
    const finish = choice?.finish_reason ?? null;
    if (!content) {
      throw new AttemptError(
        finish === "length"
          ? `${model}: all ${o.maxTokens} tokens went on thinking`
          : `${model}: empty reply (finish reason: ${finish ?? "none"})`,
        "error",
      );
    }
    if (finish === "length") {
      // Cut-off JSON is useless: try the next model instead.
      throw new AttemptError(
        `${model}: answer cut off at ${o.maxTokens} tokens`,
        "error",
      );
    }
    console.log(`${tag} done`, {
      model,
      ms: Date.now() - startedAt,
      chars: content.length,
    });
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------- Gemini ------------------------------- */

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number };
}

/** HTTP 400s that really mean "this model id doesn't exist / isn't supported". */
const GEMINI_BAD_MODEL_RE =
  /model.*(not found|not supported|is not valid|invalid|unknown|no longer available)|is not found for API version|unsupported model/i;

async function callGemini(
  apiKey: string,
  model: string,
  o: Resolved,
  timeoutMs: number,
): Promise<string> {
  const tag = `[gemini:${o.label}]`;
  const startedAt = Date.now();
  console.log(`${tag} request`, { model, maxTokens: o.maxTokens });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    let text: string;
    try {
      res = await fetch(
        `${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: o.system }] },
            contents: [{ role: "user", parts: [{ text: o.user }] }],
            generationConfig: {
              temperature: Math.min(2, o.temperature),
              // maxOutputTokens also covers "thinking" tokens on newer Gemini models.
              maxOutputTokens: o.maxTokens,
              // Keep thinking small so the answer isn't starved. Skipped for -lite models.
              ...(/lite/i.test(model)
                ? {}
                : { thinkingConfig: { thinkingLevel: "low" } }),
            },
          }),
        },
      );
      text = await res.text();
    } catch (e: unknown) {
      if (controller.signal.aborted) {
        throw new AttemptError(
          `${model}: no answer within ${Math.round(timeoutMs / 1000)}s`,
          "timeout",
        );
      }
      throw new AttemptError(
        `${model}: network error ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }

    if (!res.ok) {
      console.error(`${tag} HTTP error`, {
        model,
        status: res.status,
        body: text.slice(0, 500),
      });
      const message = `Gemini ${res.status} (${model}): ${text.slice(0, 300)}`;
      if (
        res.status === 401 ||
        res.status === 403 ||
        (res.status === 400 && /API_KEY|API key/i.test(text))
      ) {
        throw new AttemptError(message, "auth");
      }
      if (
        res.status === 404 ||
        (res.status === 400 && GEMINI_BAD_MODEL_RE.test(text))
      ) {
        throw new AttemptError(message, "gone");
      }
      if (res.status === 429) throw new AttemptError(message, "rate_limited");
      if (isServerBusy(res.status)) {
        throw new AttemptError(message, "overloaded");
      }
      throw new AttemptError(message, "error");
    }

    let json: GeminiResponse;
    try {
      json = JSON.parse(text) as GeminiResponse;
    } catch {
      throw new AttemptError(`${model}: unreadable reply`, "error");
    }

    const candidate = json.candidates?.[0];
    const finish = candidate?.finishReason;
    // Skip "thought" parts (thinking summaries); keep real answer text only.
    const content = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!content) {
      const blocked = json.promptFeedback?.blockReason;
      throw new AttemptError(
        finish === "MAX_TOKENS"
          ? `${model}: all ${o.maxTokens} tokens went on thinking`
          : `${model}: empty reply${blocked ? ` (blocked: ${blocked})` : ` (finish reason: ${finish ?? "none"})`}`,
        "error",
      );
    }
    if (finish === "MAX_TOKENS") {
      throw new AttemptError(
        `${model}: answer cut off at ${o.maxTokens} tokens`,
        "error",
      );
    }
    console.log(`${tag} done`, {
      model,
      ms: Date.now() - startedAt,
      chars: content.length,
    });
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- public API ---------------------------- */

/** True when at least one AI key is configured. */
export function hasAiKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY);
}

export interface CallOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** Sent to OpenRouter as X-Title. */
  title?: string;
  /** Tags log lines, e.g. "melody". */
  label?: string;
  /** Try this OpenRouter model FIRST (the rest of the list is still the backup). */
  model?: string;
  /**
   * Start this many models further down the list. ai.ts uses it so a retry
   * after a bad answer asks a DIFFERENT model instead of the same one again.
   */
  rotate?: number;
  reasoningEffort?: ReasoningEffort;
  /** Give up on ONE model after this long. */
  timeoutMs?: number;
  /** Give up on the whole fallback chain after this long. */
  totalTimeoutMs?: number;
}

/**
 * Asks the AI and returns its text. If a model fails (gone, rate limited,
 * overloaded, down, timed out, empty or cut off) the next model is tried
 * automatically. Throws a ModelError only when every model has failed.
 */
export async function callModel(opts: CallOptions): Promise<string> {
  const openrouterKey = process.env.OPENROUTER_API_KEY || undefined;
  const geminiKey = process.env.GEMINI_API_KEY || undefined;
  if (!openrouterKey && !geminiKey) {
    throw new ModelError(
      "No AI key is set (OPENROUTER_API_KEY or GEMINI_API_KEY)",
      2000,
    );
  }

  if (!geminiKey && !warnedNoGemini) {
    warnedNoGemini = true;
    console.warn(
      "[ai] GEMINI_API_KEY is not set, so only OpenRouter free models are tried and they are often rate limited or retired. Add one: npx convex env set GEMINI_API_KEY <key> (free key at https://aistudio.google.com/apikey)",
    );
  }

  const resolved: Resolved = {
    system: opts.system,
    user: opts.user,
    temperature: opts.temperature ?? 0.9,
    maxTokens: opts.maxTokens ?? 12000,
    effort: opts.reasoningEffort ?? "low",
    title: opts.title ?? "Song Writer",
    label: opts.label ?? "ai",
  };
  const perAttemptMs = opts.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const deadline =
    Date.now() + (opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);

  let attempts = buildAttempts(
    Boolean(openrouterKey),
    Boolean(geminiKey),
    opts.model,
  );
  if (attempts.length === 0) {
    throw new ModelError(
      "No usable AI models configured (check OPENROUTER_MODELS / GEMINI_MODELS)",
      2000,
    );
  }
  const shift = (opts.rotate ?? 0) % attempts.length;
  if (shift > 0)
    attempts = [...attempts.slice(shift), ...attempts.slice(0, shift)];
  console.log(
    `[ai:${resolved.label}] models in order`,
    attempts.map((a) => `${a.provider}:${a.model}`),
  );

  const failures: string[] = [];
  const deadProviders = new Set<Provider>(); // provider whose key was rejected
  const deadModels = new Set<string>();
  let sawRateLimit = false;

  for (const attempt of attempts) {
    const id = `${attempt.provider}:${attempt.model}`;
    if (deadProviders.has(attempt.provider) || deadModels.has(id)) continue;

    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_WINDOW_MS) {
      failures.push("out of time");
      break;
    }
    const timeoutMs = Math.min(perAttemptMs, remaining);

    try {
      return attempt.provider === "openrouter"
        ? await callOpenRouter(
            openrouterKey ?? "",
            attempt.model,
            resolved,
            timeoutMs,
          )
        : await callGemini(geminiKey ?? "", attempt.model, resolved, timeoutMs);
    } catch (e: unknown) {
      if (!(e instanceof AttemptError)) throw e;
      failures.push(`${id} -> ${e.kind}`);
      if (e.kind === "rate_limited") sawRateLimit = true;
      if (e.kind === "auth") {
        deadProviders.add(attempt.provider);
        console.error(
          `[ai:${resolved.label}] ${attempt.provider} key was rejected - skipping that provider`,
        );
      } else if (e.kind === "gone") {
        deadModels.add(id);
        markDead(id);
      } else if (e.kind === "overloaded") {
        markDead(id, OVERLOADED_TTL_MS);
      }
      console.warn(
        `[ai:${resolved.label}] ${id} failed (${e.kind}), trying next`,
        {
          message: e.message.slice(0, 300),
        },
      );
    }
  }

  const allAuth =
    failures.length > 0 && failures.every((f) => f.endsWith("-> auth"));
  throw new ModelError(
    allAuth
      ? "The AI keys were rejected (check OPENROUTER_API_KEY / GEMINI_API_KEY)"
      : `All AI models failed: ${failures.join(" | ")}`,
    sawRateLimit ? 6000 : 2000,
  );
}
