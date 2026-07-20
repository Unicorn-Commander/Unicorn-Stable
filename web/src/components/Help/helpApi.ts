/**
 * Client for the help-agent endpoints.
 *
 * Small and local rather than a method on the shared `api` client, because the
 * help surface is self-contained and this keeps the whole feature in one
 * directory. It resolves the active federated instance the same way
 * `services/api.ts` does, so asking for help on server B never talks to
 * server A.
 */
import { getToken, refreshToken } from "@/services/auth";
import { useFederationStore } from "@/stores/federationStore";
import type { HelpArticle } from "@/content/help";

function activeBaseUrl(): string {
  const fed = useFederationStore.getState();
  return (
    fed.accessibleInstances.find((i) => i.id === fed.activeInstanceId)
      ?.apiBaseUrl ??
    import.meta.env.VITE_API_BASE_URL ??
    ""
  );
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = getToken() ?? (await refreshToken());
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface HelpAgentStatus {
  enabled: boolean;
  model: string;
  /** `local_zero` — a real $0 — or `external`, billed upstream. */
  pricing: "local_zero" | "external" | string;
  /**
   * `null` means "we could not check", which is NOT the same claim as `false`
   * ("it is down"). Kept tri-state all the way to the UI on purpose.
   */
  reachable: boolean | null;
}

export interface HelpTurn {
  role: "user" | "assistant";
  content: string;
}

export interface HelpAnswer {
  answer: string;
  /** The logical model name Stable asked the gateway for. */
  model: string;
  /** What the gateway actually served it with. */
  served_by: string;
  pricing: "local_zero" | "external" | string;
  /** Real 0 for local; `null` when the rate is not ours to state. */
  cost_usd: number | null;
}

/**
 * A failure with a message that came from the server and is safe to show as-is.
 * The help endpoints return user-facing `detail` strings (busy / starting up /
 * unreachable) precisely so the UI does not have to invent its own.
 */
export class HelpApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HelpApiError";
    this.status = status;
  }
}

async function parseError(response: Response, fallback: string): Promise<never> {
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    /* non-JSON error body — use the fallback */
  }
  throw new HelpApiError(detail ?? fallback, response.status);
}

export async function fetchHelpAgentStatus(): Promise<HelpAgentStatus> {
  const response = await fetch(`${activeBaseUrl()}/api/v1/help/agent`, {
    headers: await authHeaders(),
  });
  if (!response.ok) {
    return parseError(response, "Couldn't check the help agent.");
  }
  return (await response.json()) as HelpAgentStatus;
}

export async function askHelpAgent(opts: {
  question: string;
  /** Best-match-first; the server clamps how many and how much it uses. */
  articles: HelpArticle[];
  history: HelpTurn[];
  signal?: AbortSignal;
}): Promise<HelpAnswer> {
  const response = await fetch(`${activeBaseUrl()}/api/v1/help/agent/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    signal: opts.signal,
    body: JSON.stringify({
      question: opts.question,
      articles: opts.articles.map((a) => ({ title: a.title, body: a.body })),
      history: opts.history,
    }),
  });
  if (!response.ok) {
    return parseError(response, "The help agent couldn't answer that one.");
  }
  return (await response.json()) as HelpAnswer;
}
