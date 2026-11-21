// convex/lib/openrouter.ts
// One place that talks to OpenRouter, used by the song writer AND the melody
// composer. (Kept out of ai.ts because "use node" files may only export actions.)

export const DEFAULT_MODEL =
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";

interface OpenRouterResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string; code?: number };
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callModel(opts: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  title?: string;
}): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      "X-Title": opts.title ?? "Song Writer",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      temperature: opts.temperature ?? 0.9,
      // Reasoning models spend tokens thinking first, so leave plenty of room.
      max_tokens: opts.maxTokens ?? 12000,
    }),
  });

  const text = await res.text();
  let json: OpenRouterResponse;
  try {
    json = JSON.parse(text) as OpenRouterResponse;
  } catch {
    throw new ModelError(
      `OpenRouter sent an unreadable reply (HTTP ${res.status})`,
      2000,
    );
  }

  if (!res.ok || json.error) {
    const rateLimited = res.status === 429 || json.error?.code === 429;
    throw new ModelError(
      json.error?.message ?? `OpenRouter error (HTTP ${res.status})`,
      rateLimited ? 6000 : 2000,
    );
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new ModelError("The model returned an empty reply", 2000);
  }
  return content;
}
