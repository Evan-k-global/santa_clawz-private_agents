import type {
  AgentProfileState,
  AgentRegistryEntry,
  ConsoleStateResponse,
  HireRequestReceipt,
  PrivacyApprovalRecord,
  TrustModeId
} from "@clawz/protocol";

const LOCAL_INDEXER_BASE = "http://127.0.0.1:4318";
const DEFAULT_ZEKO_FAUCET_UI_URL = "https://faucet.zeko.io";
const DEFAULT_ZEKO_FAUCET_CLAIM_API_URL = "https://api.faucet.zeko.io/claim";
type LiveFlowKind = "first-turn" | "next-turn" | "abort-turn" | "refund-turn" | "revoke-disclosure";

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveApiBase() {
  const configuredBase =
    typeof import.meta.env.VITE_CLAWZ_API_BASE_URL === "string"
      ? import.meta.env.VITE_CLAWZ_API_BASE_URL.trim()
      : "";
  if (configuredBase.length > 0) {
    return normalizeBaseUrl(configuredBase);
  }

  if (typeof window !== "undefined") {
    const { hostname, port, protocol, host } = window.location;
    if ((hostname === "127.0.0.1" || hostname === "localhost") && port === "4173") {
      return LOCAL_INDEXER_BASE;
    }
    return `${protocol}//${host}`;
  }

  return LOCAL_INDEXER_BASE;
}

const API_BASE = resolveApiBase();

export function getApiBase() {
  return API_BASE;
}

function resolveOptionalUrl(value: string | undefined, fallback: string) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? normalizeBaseUrl(trimmed) : fallback;
}

export function getZekoFaucetConfig() {
  return {
    uiUrl: resolveOptionalUrl(import.meta.env.VITE_ZEKO_FAUCET_UI_URL, DEFAULT_ZEKO_FAUCET_UI_URL),
    claimApiUrl: resolveOptionalUrl(import.meta.env.VITE_ZEKO_FAUCET_CLAIM_API_URL, DEFAULT_ZEKO_FAUCET_CLAIM_API_URL)
  };
}

function buildPath(path: string, sessionId?: string, agentId?: string) {
  if (!sessionId && !agentId) {
    return path;
  }

  const params = new URLSearchParams();
  if (sessionId) {
    params.set("sessionId", sessionId);
  }
  if (agentId) {
    params.set("agentId", agentId);
  }
  return `${path}?${params.toString()}`;
}

export interface RunLiveFlowOptions {
  flowKind?: LiveFlowKind;
  sessionId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: {
        "content-type": "application/json"
      },
      ...init
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed.";
    throw new Error(
      `SantaClawz could not reach the onboarding API at ${API_BASE}. Check that the Render backend is live and CORS allows this domain. (${message})`
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function fetchConsoleState(sessionId?: string, agentId?: string): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath("/api/console/state", sessionId, agentId));
}

export function fetchAgentRegistry(): Promise<AgentRegistryEntry[]> {
  return request<AgentRegistryEntry[]>("/api/agents");
}

export function registerAgent(input: {
  agentName: string;
  representedPrincipal?: string;
  headline: string;
  openClawUrl: string;
  payoutWallets?: AgentProfileState["payoutWallets"];
  trustModeId?: TrustModeId;
  preferredProvingLocation?: AgentProfileState["preferredProvingLocation"];
}): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>("/api/console/register", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function submitHireRequest(
  agentId: string,
  input: {
    taskPrompt: string;
    requesterContact: string;
    budgetMina?: string;
  }
): Promise<HireRequestReceipt> {
  return request<HireRequestReceipt>(`/api/agents/${encodeURIComponent(agentId)}/hire`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function runLiveSessionTurnFlow(
  options: RunLiveFlowOptions | LiveFlowKind = "first-turn"
): Promise<ConsoleStateResponse> {
  const payload = typeof options === "string" ? { flowKind: options } : { flowKind: "first-turn" as const, ...options };

  return request<ConsoleStateResponse>("/api/zeko/session-turn/run", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateTrustMode(modeId: TrustModeId, sessionId?: string): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath("/api/console/trust-mode", sessionId), {
    method: "POST",
    body: JSON.stringify({
      modeId,
      ...(sessionId ? { sessionId } : {})
    })
  });
}

export function updateAgentProfile(
  profile: AgentProfileState,
  sessionId?: string
): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath("/api/console/profile", sessionId), {
    method: "POST",
    body: JSON.stringify({
      ...profile,
      ...(sessionId ? { sessionId } : {})
    })
  });
}

export function sponsorWallet(
  amountMina = "0.10",
  sessionId?: string,
  purpose?: "onboarding" | "top-up" | "publish"
): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath("/api/wallet/sponsor", sessionId), {
    method: "POST",
    body: JSON.stringify({
      amountMina,
      ...(purpose ? { purpose } : {}),
      ...(sessionId ? { sessionId } : {})
    })
  });
}

export function prepareRecoveryKit(sessionId?: string): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath("/api/wallet/recovery/prepare", sessionId), {
    method: "POST",
    body: JSON.stringify(sessionId ? { sessionId } : {})
  });
}

export function approvePrivacyException(
  exceptionId: string,
  actorId = "guardian_compliance",
  actorRole: PrivacyApprovalRecord["actorRole"] = "compliance-reviewer",
  note = "Approved from the ClawZ console.",
  sessionId?: string
): Promise<ConsoleStateResponse> {
  return request<ConsoleStateResponse>(buildPath(`/api/privacy-exceptions/${exceptionId}/approve`, sessionId), {
    method: "POST",
    body: JSON.stringify({
      actorId,
      actorRole,
      note,
      ...(sessionId ? { sessionId } : {})
    })
  });
}
