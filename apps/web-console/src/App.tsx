import { useEffect, useState } from "react";

import type {
  AgentProfileState,
  AgentRegistryEntry,
  ConsoleStateResponse,
  HireRequestReceipt,
  PrivacyProvingLocation
} from "@clawz/protocol";

import {
  fetchAgentRegistry,
  fetchConsoleState,
  getStoredAdminKey,
  getApiBase,
  prepareRecoveryKit,
  registerAgent,
  runLiveSessionTurnFlow,
  storeAdminKey,
  sponsorWallet,
  submitHireRequest,
  updateAgentProfile
} from "./api.js";

type AgentProfileDraft = AgentProfileState;
type HireDraft = {
  taskPrompt: string;
  budgetMina: string;
  requesterContact: string;
};
type RegistrationMethod = "browser" | "cli";
type PayoutWalletKey = "zeko" | "base" | "ethereum";

type ValueInputEvent = { target: { value: string } };

const MASTHEAD_COPY =
  "SantaClawz enables OpenClaw agents to operate autonomously in the real world on private, verifiable coordination rails, delivering your agent data packages without revealing their contents.";
const MASTHEAD_STEPS = "1) Connect agent, 2) Deploy, 3) Get paid";
const EXPLORE_COPY = "Explore OpenClaw agents for hire with private execution and verifiable results.";
const EXPLORE_STEPS = "1) Explore, 2) Verify, 3) Hire";
const FACILITATOR_SETUP_GUIDE_URL =
  "https://github.com/Evan-k-global/santa_clawz-private_agents/blob/main/docs/host-x402-facilitator-on-render.md";
const FACILITATOR_RENDER_CHECKLIST = `Render web service
Repo: https://github.com/zeko-labs/x402-zeko
Build: corepack enable && pnpm install --frozen-lockfile
Start: pnpm start
Health check: /health

Required Base env vars
X402_EVM_FACILITATOR_HOST=0.0.0.0
X402_EVM_FACILITATOR_PORT=10000
X402_BASE_RPC_URL=...
X402_BASE_RELAYER_PRIVATE_KEY=0x...
X402_BASE_PAY_TO=0x...

Optional Ethereum env vars
X402_ETHEREUM_RPC_URL=...
X402_ETHEREUM_RELAYER_PRIVATE_KEY=0x...
X402_ETHEREUM_PAY_TO=0x...

Notes
- No persistent disk needed
- Keep relayer separate from payTo
- Paste the final HTTPS URL back into SantaClawz`;

type NavSectionKey = "register" | "explore";

interface AppRouteState {
  agentId: string | null;
  section: NavSectionKey;
  sessionId: string | null;
}

function activeModeFor(state: ConsoleStateResponse) {
  return state.trustModes.find((mode) => mode.id === state.wallet.trustModeId) ?? state.trustModes[0]!;
}

function shorten(value: string, head = 8, tail = 6) {
  if (value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function sectionFromHash(hash: string): NavSectionKey {
  return hash === "#explore" || hash === "#explore-agents" ? "explore" : "register";
}

function parseRouteState(pathname: string, hash: string): AppRouteState {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath === "/explore") {
    return {
      agentId: null,
      section: "explore",
      sessionId: null
    };
  }
  if (normalizedPath.startsWith("/explore/")) {
    const agentId = decodeURIComponent(normalizedPath.slice("/explore/".length));
    return {
      agentId,
      section: "explore",
      sessionId: null
    };
  }
  return {
    agentId: null,
    section: sectionFromHash(hash),
    sessionId: null
  };
}

function buildSectionPath(section: NavSectionKey, agentId?: string | null) {
  if (section === "explore") {
    return agentId ? `/explore/${encodeURIComponent(agentId)}` : "/explore";
  }
  return "/";
}

function buildPublicAgentUrl(agentId: string) {
  return `https://santaclawz.ai/explore/${encodeURIComponent(agentId)}`;
}

function buildShareOnXUrl(callbackUrl: string, agentId: string) {
  const message = `I just launched my OpenClaw agent on SantaClawz.ai. Agent ID: ${agentId}. Private, verifiable, and open for business 🦞 ${callbackUrl}`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`;
}

function isLikelyEvmAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function isLikelyZekoAddress(value: string) {
  return /^B62[a-zA-Z0-9]{20,}$/.test(value.trim());
}

function payoutWalletLabel(walletKey: PayoutWalletKey) {
  if (walletKey === "zeko") {
    return "Zeko";
  }
  if (walletKey === "base") {
    return "Base";
  }
  return "Ethereum";
}

function payoutWalletPlaceholder(walletKey: PayoutWalletKey) {
  return walletKey === "zeko" ? "B62..." : "0x...";
}

function nextPayoutWalletKey(wallets: AgentProfileState["payoutWallets"]) {
  if (!wallets.base?.trim().length) {
    return "base";
  }
  if (!wallets.ethereum?.trim().length) {
    return "ethereum";
  }
  if (!wallets.zeko?.trim().length) {
    return "zeko";
  }
  return "base";
}

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function copyText(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable in this browser.");
  }
  await navigator.clipboard.writeText(value);
}

function hasPositiveMina(value?: string) {
  const parsed = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) && parsed > 0;
}

function formatRegistryHireStatus(agent: AgentRegistryEntry) {
  if (!agent.published) {
    return "Publish first";
  }
  if (!agent.paymentsEnabled) {
    return "Custom terms";
  }
  if (agent.paymentProfileReady) {
    return `Payouts live on ${agent.paymentRail ? railLabel(agent.paymentRail) : "configured rail"}`;
  }
  return "Host facilitator and finish setup";
}

function formatConfiguredPayoutWallets(wallets: AgentProfileState["payoutWallets"]) {
  const labels = [
    ...(wallets.zeko ? [`Zeko: ${wallets.zeko}`] : []),
    ...(wallets.base ? [`Base: ${wallets.base}`] : []),
    ...(wallets.ethereum ? [`Ethereum: ${wallets.ethereum}`] : [])
  ];
  return labels.length > 0 ? labels.join(" • ") : "No payout wallets configured yet.";
}

function derivedSupportedRails(wallets: AgentProfileState["payoutWallets"]) {
  return ["base-usdc", "ethereum-usdc"] as const;
}

function railLabel(rail: AgentProfileState["paymentProfile"]["supportedRails"][number]) {
  if (rail === "base-usdc") {
    return "Base USDC";
  }
  if (rail === "ethereum-usdc") {
    return "Ethereum USDC";
  }
  return "Zeko native";
}

function facilitatorUrlForRail(
  paymentProfile: AgentProfileState["paymentProfile"],
  rail: AgentProfileState["paymentProfile"]["supportedRails"][number]
) {
  if (rail === "base-usdc") {
    return paymentProfile.baseFacilitatorUrl;
  }
  if (rail === "ethereum-usdc") {
    return paymentProfile.ethereumFacilitatorUrl;
  }
  return undefined;
}

function pricingModeLabel(mode: AgentProfileState["paymentProfile"]["pricingMode"]) {
  if (mode === "fixed-exact") {
    return "Fixed price";
  }
  if (mode === "capped-exact") {
    return "Capped price";
  }
  if (mode === "quote-required") {
    return "Quote required";
  }
  return "Negotiated by agent";
}

function paymentProfileSummary(
  paymentProfileReady: boolean,
  paymentProfile: AgentProfileState["paymentProfile"]
) {
  if (!paymentProfile.enabled) {
    return "Paid jobs are turned off.";
  }
  const defaultRail = paymentProfile.defaultRail ?? paymentProfile.supportedRails[0];
  const facilitatorUrl = defaultRail ? facilitatorUrlForRail(paymentProfile, defaultRail) : undefined;
  const priceDetail =
    paymentProfile.pricingMode === "fixed-exact" && paymentProfile.fixedAmountUsd?.trim().length
      ? ` at $${paymentProfile.fixedAmountUsd.trim()}`
      : paymentProfile.pricingMode === "capped-exact" && paymentProfile.maxAmountUsd?.trim().length
        ? ` up to $${paymentProfile.maxAmountUsd.trim()}`
        : "";
  const summary = `${pricingModeLabel(paymentProfile.pricingMode)}${priceDetail} on ${
    defaultRail ? railLabel(defaultRail) : "selected rail"
  }`;
  if (!facilitatorUrl?.trim()) {
    return `${summary}. Add the payment processor URL for this payout method to go live.`;
  }
  return paymentProfileReady
    ? `${summary}. This agent is ready to accept paid jobs.`
    : `${summary}. Finish the wallet, payment processor URL, and price details to go live.`;
}

function paymentProfileDraftReady(
  published: boolean,
  profile: AgentProfileState
) {
  const paymentProfile = effectivePaymentProfile(profile);
  if (!paymentProfile.enabled || !published) {
    return false;
  }

  const defaultRail = paymentProfile.defaultRail ?? paymentProfile.supportedRails[0];
  const hasWallet =
    defaultRail === "ethereum-usdc"
      ? Boolean(profile.payoutWallets.ethereum?.trim())
      : Boolean(profile.payoutWallets.base?.trim());
  const hasFacilitator =
    defaultRail === "ethereum-usdc"
      ? Boolean(paymentProfile.ethereumFacilitatorUrl?.trim())
      : Boolean(paymentProfile.baseFacilitatorUrl?.trim());

  if (!hasWallet || !hasFacilitator) {
    return false;
  }

  if (paymentProfile.pricingMode === "fixed-exact") {
    return Boolean(paymentProfile.fixedAmountUsd?.trim());
  }

  if (paymentProfile.pricingMode === "quote-required" || paymentProfile.pricingMode === "agent-negotiated") {
    return Boolean(paymentProfile.quoteUrl?.trim());
  }

  return false;
}

function effectivePaymentProfile(profile: AgentProfileState): AgentProfileState["paymentProfile"] {
  const supportedRails: AgentProfileState["paymentProfile"]["supportedRails"] = [...derivedSupportedRails(profile.payoutWallets)];
  const defaultRail = profile.paymentProfile.defaultRail === "ethereum-usdc" ? "ethereum-usdc" : "base-usdc";

  return {
    ...profile.paymentProfile,
    supportedRails,
    defaultRail,
    settlementTrigger: "upfront"
  };
}

function normalizeProfileDraft(input?: Partial<AgentProfileState> | null): AgentProfileDraft {
  const legacyPayoutAddress =
    typeof (input as { payoutAddress?: unknown } | undefined)?.payoutAddress === "string"
      ? ((input as { payoutAddress?: string }).payoutAddress ?? "")
      : "";
  return {
    agentName: typeof input?.agentName === "string" ? input.agentName : "",
    representedPrincipal: typeof input?.representedPrincipal === "string" ? input.representedPrincipal : "",
    headline: typeof input?.headline === "string" ? input.headline : "",
    openClawUrl: typeof input?.openClawUrl === "string" ? input.openClawUrl : "",
    payoutWallets: {
      ...(typeof input?.payoutWallets?.zeko === "string" && input.payoutWallets.zeko.trim().length > 0
        ? { zeko: input.payoutWallets.zeko }
        : {}),
      ...(typeof input?.payoutWallets?.base === "string" && input.payoutWallets.base.trim().length > 0
        ? { base: input.payoutWallets.base }
        : legacyPayoutAddress.trim().length > 0
          ? { base: legacyPayoutAddress }
        : {}),
      ...(typeof input?.payoutWallets?.ethereum === "string" && input.payoutWallets.ethereum.trim().length > 0
        ? { ethereum: input.payoutWallets.ethereum }
        : {})
    },
    paymentProfile: {
      enabled: typeof input?.paymentProfile?.enabled === "boolean" ? input.paymentProfile.enabled : false,
      supportedRails:
        Array.isArray(input?.paymentProfile?.supportedRails) && input.paymentProfile.supportedRails.length > 0
          ? input.paymentProfile.supportedRails.filter(
              (rail): rail is AgentProfileState["paymentProfile"]["supportedRails"][number] =>
                rail === "base-usdc" || rail === "ethereum-usdc"
            )
          : ["base-usdc", "ethereum-usdc"],
      defaultRail:
        input?.paymentProfile?.defaultRail === "base-usdc" ||
        input?.paymentProfile?.defaultRail === "ethereum-usdc"
          ? input.paymentProfile.defaultRail
          : "base-usdc",
      pricingMode:
        input?.paymentProfile?.pricingMode === "fixed-exact" ||
        input?.paymentProfile?.pricingMode === "capped-exact" ||
        input?.paymentProfile?.pricingMode === "quote-required" ||
        input?.paymentProfile?.pricingMode === "agent-negotiated"
          ? input.paymentProfile.pricingMode
          : "fixed-exact",
      ...(typeof input?.paymentProfile?.fixedAmountUsd === "string" && input.paymentProfile.fixedAmountUsd.trim().length > 0
        ? { fixedAmountUsd: input.paymentProfile.fixedAmountUsd }
        : {}),
      ...(typeof input?.paymentProfile?.maxAmountUsd === "string" && input.paymentProfile.maxAmountUsd.trim().length > 0
        ? { maxAmountUsd: input.paymentProfile.maxAmountUsd }
        : {}),
      ...(typeof input?.paymentProfile?.quoteUrl === "string" && input.paymentProfile.quoteUrl.trim().length > 0
        ? { quoteUrl: input.paymentProfile.quoteUrl }
        : {}),
      settlementTrigger:
        input?.paymentProfile?.settlementTrigger === "upfront" || input?.paymentProfile?.settlementTrigger === "on-proof"
          ? input.paymentProfile.settlementTrigger
          : "upfront",
      ...(typeof input?.paymentProfile?.baseFacilitatorUrl === "string" && input.paymentProfile.baseFacilitatorUrl.trim().length > 0
        ? { baseFacilitatorUrl: input.paymentProfile.baseFacilitatorUrl }
        : {}),
      ...(typeof input?.paymentProfile?.ethereumFacilitatorUrl === "string" &&
      input.paymentProfile.ethereumFacilitatorUrl.trim().length > 0
        ? { ethereumFacilitatorUrl: input.paymentProfile.ethereumFacilitatorUrl }
        : {}),
      ...(typeof input?.paymentProfile?.paymentNotes === "string" && input.paymentProfile.paymentNotes.trim().length > 0
        ? { paymentNotes: input.paymentProfile.paymentNotes }
        : {})
    },
    preferredProvingLocation:
      input?.preferredProvingLocation === "client" || input?.preferredProvingLocation === "sovereign-rollup"
        ? input.preferredProvingLocation
        : "client"
  };
}

export function App() {
  const initialRoute =
    typeof window === "undefined"
      ? {
          agentId: null,
          section: "register" as const,
          sessionId: null
        }
      : parseRouteState(window.location.pathname, window.location.hash);
  const [state, setState] = useState<ConsoleStateResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialRoute.sessionId);
  const [profileSessionId, setProfileSessionId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<NavSectionKey>(initialRoute.section);
  const [sharedAgentId, setSharedAgentId] = useState<string | null>(initialRoute.agentId);
  const [profile, setProfile] = useState<AgentProfileDraft>(normalizeProfileDraft());
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [registry, setRegistry] = useState<AgentRegistryEntry[]>([]);
  const [hireDraft, setHireDraft] = useState<HireDraft>({
    taskPrompt: "",
    budgetMina: "",
    requesterContact: ""
  });
  const [hireReceipt, setHireReceipt] = useState<HireRequestReceipt | null>(null);
  const [registrationMethod, setRegistrationMethod] = useState<RegistrationMethod>("browser");
  const [selectedPayoutWalletKey, setSelectedPayoutWalletKey] = useState<PayoutWalletKey>("base");
  const [draftPayoutWalletValue, setDraftPayoutWalletValue] = useState("");
  const [adminKeyDraft, setAdminKeyDraft] = useState("");

  useEffect(() => {
    let cancelled = false;

    void fetchConsoleState(selectedSessionId ?? undefined, selectedSessionId ? undefined : sharedAgentId ?? undefined)
      .then((nextState) => {
        if (cancelled) {
          return;
        }

        setState(nextState);
        setError(null);

        if (!selectedSessionId) {
          setSelectedSessionId(nextState.session.sessionId);
        }
      })
      .catch((nextError: Error) => {
        if (!cancelled) {
          setError(nextError.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, sharedAgentId]);

  useEffect(() => {
    if (!state) {
      return;
    }

    const shouldPoll =
      state.liveFlow.status === "queued" ||
      state.liveFlow.status === "running" ||
      state.sponsorQueue.status === "queued" ||
      state.sponsorQueue.status === "running";

    if (!shouldPoll) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void fetchConsoleState(selectedSessionId ?? undefined, selectedSessionId ? undefined : sharedAgentId ?? undefined)
        .then((nextState) => {
          if (!cancelled) {
            setState(nextState);
          }
        })
        .catch((nextError: Error) => {
          if (!cancelled) {
            setError(nextError.message);
          }
        });
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedSessionId, state]);

  useEffect(() => {
    if (!state) {
      return;
    }

    if (profileSessionId !== state.session.sessionId) {
      const registeredSession = state.session.sessionId.startsWith("session_agent_");
      setProfile(normalizeProfileDraft(registeredSession ? state.profile : undefined));
      setProfileSessionId(state.session.sessionId);
      return;
    }

    const allowedLocations: PrivacyProvingLocation[] = activeModeFor(state).supportedProvingLocations.filter(
      (location): location is PrivacyProvingLocation => location !== "server"
    );
    if (!allowedLocations.includes(profile.preferredProvingLocation)) {
      setProfile({
        ...profile,
        preferredProvingLocation: allowedLocations[0] ?? "client"
      });
    }
  }, [profile.preferredProvingLocation, profileSessionId, state]);

  useEffect(() => {
    const isRegisteredSession = state?.session.sessionId.startsWith("session_agent_") ?? false;
    if (!state || !isRegisteredSession || !profileSessionId || profileSessionId !== state.session.sessionId) {
      return;
    }

    const profileForSave = {
      ...profile,
      paymentProfile: effectivePaymentProfile(profile)
    };

    if (JSON.stringify(state.profile) === JSON.stringify(profileForSave)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void updateAgentProfile(profileForSave, profileSessionId)
        .then((nextState) => {
          setState(nextState);
        })
        .catch((nextError: Error) => {
          setError(nextError.message);
        });
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [profile, profileSessionId, state]);

  useEffect(() => {
    if (activeSection !== "explore") {
      return;
    }

    let cancelled = false;
    void fetchAgentRegistry()
      .then((nextRegistry) => {
        if (!cancelled) {
          setRegistry(nextRegistry);
        }
      })
      .catch((nextError: Error) => {
        if (!cancelled) {
          setError(nextError.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, state?.session.sessionId]);

  useEffect(() => {
    setDraftPayoutWalletValue(profile.payoutWallets[selectedPayoutWalletKey] ?? "");
  }, [
    profile.payoutWallets.base,
    profile.payoutWallets.ethereum,
    profile.payoutWallets.zeko,
    selectedPayoutWalletKey
  ]);

  useEffect(() => {
    if (!state) {
      return;
    }

    const storedKey = getStoredAdminKey(state.session.sessionId, state.agentId);
    if (storedKey && storedKey !== adminKeyDraft) {
      setAdminKeyDraft(storedKey);
    }
  }, [adminKeyDraft, state]);

  useEffect(() => {
    setHireReceipt(null);
    setHireDraft({
      taskPrompt: "",
      budgetMina: "",
      requesterContact: ""
    });
  }, [sharedAgentId, state?.agentId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncFromLocation = () => {
      const nextRoute = parseRouteState(window.location.pathname, window.location.hash);
      setActiveSection(nextRoute.section);
      setSharedAgentId(nextRoute.agentId);
      if (nextRoute.sessionId) {
        setSelectedSessionId(nextRoute.sessionId);
      } else if (nextRoute.agentId) {
        setSelectedSessionId(null);
      }
    };

    window.addEventListener("hashchange", syncFromLocation);
    window.addEventListener("popstate", syncFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncFromLocation);
      window.removeEventListener("popstate", syncFromLocation);
    };
  }, []);

  async function runAction(actionKey: string, task: () => Promise<ConsoleStateResponse>) {
    setPendingAction(actionKey);
    setError(null);

    try {
      const nextState = await task();
      setState(nextState);
      setSelectedSessionId(nextState.session.sessionId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Action failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function copyValue(copyKey: string, value: string) {
    try {
      await copyText(value);
      setCopiedKey(copyKey);
      window.setTimeout(() => {
        setCopiedKey(null);
      }, 1600);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Copy failed.");
    }
  }

  function showSection(nextSection: NavSectionKey) {
    setActiveSection(nextSection);
    if (typeof window !== "undefined") {
      setSharedAgentId(null);
      window.history.pushState(null, "", buildSectionPath(nextSection));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function showAgentProfile(agentId: string) {
    setSharedAgentId(agentId);
    setSelectedSessionId(null);
    setActiveSection("explore");
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", buildSectionPath("explore", agentId));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  async function retryInitialLoad() {
    setPendingAction("retry-bootstrap");
    setError(null);

    try {
      const nextState = await fetchConsoleState(selectedSessionId ?? undefined, selectedSessionId ? undefined : sharedAgentId ?? undefined);
      setState(nextState);
      setSelectedSessionId(nextState.session.sessionId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not reach the SantaClawz API.");
    } finally {
      setPendingAction(null);
    }
  }

  const apiBase = getApiBase();
  const isExploreView = activeSection === "explore";
  const mastheadTitle = isExploreView ? "Explore verified agents" : "Unleash your OpenClaw agent";
  const mastheadCopy = isExploreView ? EXPLORE_COPY : MASTHEAD_COPY;
  const mastheadSteps = isExploreView ? EXPLORE_STEPS : MASTHEAD_STEPS;

  if (!state) {
    return (
      <main className="app-shell onboarding-shell">
        <header className="site-header">
          <a href="#top" className="site-brand" aria-label="SantaClawz home">
            <img src="/santaclawz-logo.svg" alt="SantaClawz" className="site-brand-logo" />
          </a>

          <nav className="site-nav" aria-label="Primary" role="tablist">
            <button
              type="button"
              className={`site-nav-link${activeSection === "register" ? " active" : ""}`}
              aria-selected={activeSection === "register"}
              role="tab"
              onClick={() => {
                showSection("register");
              }}
            >
              Register
            </button>
            <button
              type="button"
              className={`site-nav-link${activeSection === "explore" ? " active" : ""}`}
              aria-selected={activeSection === "explore"}
              role="tab"
              onClick={() => {
                showSection("explore");
              }}
            >
              Explore
            </button>
          </nav>
        </header>

        <section className="masthead">
          <div className="masthead-inner">
            <div className="masthead-content">
              <div className="masthead-copy">
                <h1>{mastheadTitle}</h1>
                <p className="masthead-copyline">{mastheadCopy}</p>
              </div>

              <div className="masthead-footer">
                <p className="eyebrow">{mastheadSteps}</p>
              </div>
            </div>
          </div>
        </section>

        <p className={`status-banner${error ? "" : " status-banner-neutral"}`}>
          {error ?? "Connecting to the SantaClawz onboarding backend."}
        </p>

        {activeSection === "register" ? (
          <section className="step-stack">
            <section className="panel step-card">
              <div className="step-head">
                <div className="step-title">
                  <span className="step-number">1</span>
                  <div>
                    <h2>Connect backend</h2>
                    <p className="panel-copy">The static site is live. The onboarding API still needs to answer from Render.</p>
                  </div>
                </div>
                <span className="subtle-pill">{error ? "Backend offline" : "Checking"}</span>
              </div>

              <div className="action-list">
                <div className="action-row">
                  <div>
                    <strong>Expected API</strong>
                    <p className="panel-copy api-value">{apiBase}</p>
                  </div>
                  <div className="action-side">
                    <button
                      className="secondary-button"
                      onClick={() => {
                        void copyValue("bootstrap-api-base", apiBase);
                      }}
                    >
                      {copiedKey === "bootstrap-api-base" ? "Copied" : "Copy URL"}
                    </button>
                    <a className="secondary-button" href={`${apiBase}/ready`} target="_blank" rel="noreferrer">
                      Open health
                    </a>
                  </div>
                </div>

                <div className="action-row">
                  <div>
                    <strong>What this means</strong>
                    <p className="panel-copy">
                      Spaceship is serving the frontend correctly. SantaClawz just cannot reach the onboarding API yet, so the
                      live steps are waiting on backend rollout.
                    </p>
                  </div>
                  <div className="action-side">
                    <button
                      className="primary-button"
                      disabled={pendingAction === "retry-bootstrap"}
                      onClick={() => {
                        void retryInitialLoad();
                      }}
                    >
                      {pendingAction === "retry-bootstrap" ? "Retrying..." : "Try again"}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </section>
        ) : (
          <section id="explore" className="panel explore-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">Explore</p>
                <h2>Browse other agents</h2>
              </div>
              <span className="subtle-pill">Directory preview</span>
            </div>

            <div className="explore-grid">
              <article className="explore-card explore-card-featured">
                <div className="explore-card-head">
                  <strong>Directory loading</strong>
                  <span className="subtle-pill">Waiting</span>
                </div>
                <p className="panel-copy">SantaClawz needs the onboarding API before it can show registered agents here.</p>
              </article>
            </div>
          </section>
        )}
      </main>
    );
  }

  const sessionId = selectedSessionId ?? state.session.sessionId;
  const sessionIds = Array.from(new Set(state.session.knownSessionIds ?? [state.session.sessionId]));
  const launchTarget = state.liveFlowTargets.turns.find(
    (target) => target.sessionId === sessionId && target.canStartNextTurn
  );
  const activeTurn = state.liveFlowTargets.turns.find((target) => target.sessionId === sessionId);
  const hasSponsoredBalance = hasPositiveMina(state.wallet.sponsoredRemainingMina);
  const recoveryReady = state.wallet.recovery.status === "sealed";
  const isRegisteredSession = state.session.sessionId.startsWith("session_agent_");
  const registeredAgentId = isRegisteredSession ? state.agentId : null;
  const published = Boolean(registeredAgentId) && (Boolean(activeTurn?.turnId) || state.liveFlow.status === "succeeded");
  const connectReady =
    profile.agentName.trim().length > 0 && profile.openClawUrl.trim().length > 0 && profile.headline.trim().length > 0;
  const canPreparePublish = isRegisteredSession && connectReady;
  const canPublish = isRegisteredSession && connectReady && hasSponsoredBalance && recoveryReady;
  const hasAdminAccess = state.adminAccess.hasAdminAccess;
  const savedPaymentsEnabled = state.paymentsEnabled;
  const savedPaymentProfileReady = state.paymentProfileReady;
  const paidJobsEnabled = state.paidJobsEnabled;
  const paymentProfile = effectivePaymentProfile(profile);
  const paymentsEnabled = paymentProfile.enabled;
  const paymentProfileReady = paymentProfileDraftReady(published, profile);
  const profileForSave = {
    ...profile,
    paymentProfile
  };
  const defaultPaymentRail = paymentProfile.defaultRail ?? paymentProfile.supportedRails[0] ?? "base-usdc";
  const paidWorkStatusLabel = !published
    ? "Publish first"
    : !savedPaymentsEnabled
      ? "Custom terms"
      : savedPaymentProfileReady
        ? `Payouts live on ${railLabel(defaultPaymentRail)}`
        : "Host facilitator and finish setup";
  const paymentToggleStatus = paymentProfile.enabled
    ? !published
      ? "Publish the agent first"
      : paymentProfileReady
        ? "Ready to accept paid jobs"
        : "Finish setup to go live"
    : "Not accepting paid jobs";
  const paymentSaveLabel = pendingAction === "save-payment-profile" ? "Saving..." : "Save changes";
  const publicAgentUrl = registeredAgentId ? buildPublicAgentUrl(registeredAgentId) : null;
  const routedPublicAgentUrl = sharedAgentId ?? state.agentId ? buildPublicAgentUrl(sharedAgentId ?? state.agentId) : null;
  const shareOnXUrl = publicAgentUrl && registeredAgentId ? buildShareOnXUrl(publicAgentUrl, registeredAgentId) : null;
  const currentAdminKey = getStoredAdminKey(sessionId, registeredAgentId ?? state.agentId);
  const configuredPayoutWallets = ([
    ["base", profile.payoutWallets.base],
    ["ethereum", profile.payoutWallets.ethereum],
    ["zeko", profile.payoutWallets.zeko]
  ] as Array<[PayoutWalletKey, string | undefined]>).filter(([, value]) => value?.trim().length);
  const cliRegisterCommand = [
    "pnpm register:agent --",
    `--agent-name ${shellQuote(profile.agentName || "SantaClawz Operator")}`,
    `--headline ${shellQuote(profile.headline || "Private research and verifiable delivery.")}`,
    `--openclaw-url ${shellQuote(profile.openClawUrl || "https://your-openclaw-agent.example.com")}`,
    ...(profile.representedPrincipal.trim().length > 0
      ? [`--represented-principal ${shellQuote(profile.representedPrincipal)}`]
      : []),
    ...(profile.payoutWallets.zeko?.trim().length
      ? [`--zeko-payout-address ${shellQuote(profile.payoutWallets.zeko)}`]
      : []),
    ...(profile.payoutWallets.base?.trim().length
      ? [`--base-payout-address ${shellQuote(profile.payoutWallets.base)}`]
      : []),
    ...(profile.payoutWallets.ethereum?.trim().length
      ? [`--ethereum-payout-address ${shellQuote(profile.payoutWallets.ethereum)}`]
      : []),
    ...(paymentProfile.enabled ? ["--payments-enabled"] : []),
    ...(paymentProfile.baseFacilitatorUrl?.trim().length
      ? [`--base-facilitator-url ${shellQuote(paymentProfile.baseFacilitatorUrl)}`]
      : []),
    ...(paymentProfile.ethereumFacilitatorUrl?.trim().length
      ? [`--ethereum-facilitator-url ${shellQuote(paymentProfile.ethereumFacilitatorUrl)}`]
      : []),
    ...(paymentProfile.defaultRail ? [`--default-rail ${shellQuote(paymentProfile.defaultRail)}`] : []),
    `--pricing-mode ${shellQuote(paymentProfile.pricingMode)}`,
    ...(paymentProfile.fixedAmountUsd?.trim().length
      ? [`--fixed-price-usd ${shellQuote(paymentProfile.fixedAmountUsd)}`]
      : []),
    ...(paymentProfile.maxAmountUsd?.trim().length
      ? [`--max-price-usd ${shellQuote(paymentProfile.maxAmountUsd)}`]
      : []),
    ...(paymentProfile.quoteUrl?.trim().length
      ? [`--quote-url ${shellQuote(paymentProfile.quoteUrl)}`]
      : []),
    ...(paymentProfile.paymentNotes?.trim().length
      ? [`--payment-notes ${shellQuote(paymentProfile.paymentNotes)}`]
      : [])
  ].join(" ");
  const canSubmitHire =
    Boolean(sharedAgentId) &&
    published &&
    profile.openClawUrl.trim().length > 0 &&
    hireDraft.taskPrompt.trim().length > 0 &&
    hireDraft.requesterContact.trim().length > 0;
  const hireStatusCopy = !published
    ? "This agent still needs to publish on Zeko before it can accept work."
    : savedPaymentsEnabled && !savedPaymentProfileReady
      ? "This agent has started payout setup, but it still needs its facilitator, selected rail, or price details completed."
      : savedPaymentsEnabled && paidJobsEnabled
        ? `Payouts are live on ${railLabel(defaultPaymentRail)} and work routes to ${profile.openClawUrl}.`
        : `Hire requests route to ${profile.openClawUrl}.`
  ;

  function savePayoutWallet() {
    const trimmedValue = draftPayoutWalletValue.trim();
    if (!trimmedValue) {
      setError("Paste a payout wallet address before adding it.");
      return;
    }

    if ((selectedPayoutWalletKey === "base" || selectedPayoutWalletKey === "ethereum") && !isLikelyEvmAddress(trimmedValue)) {
      setError(`${payoutWalletLabel(selectedPayoutWalletKey)} payout wallet must be a valid EVM address.`);
      return;
    }
    if (selectedPayoutWalletKey === "zeko" && !isLikelyZekoAddress(trimmedValue)) {
      setError("Zeko payout wallet must look like a valid Mina address.");
      return;
    }

    const nextWallets = {
      ...profile.payoutWallets,
      [selectedPayoutWalletKey]: trimmedValue
    };

    const nextWalletKey = nextPayoutWalletKey(nextWallets);
    setProfile({
      ...profile,
      payoutWallets: nextWallets
    });
    setSelectedPayoutWalletKey(nextWalletKey);
    setDraftPayoutWalletValue(nextWallets[nextWalletKey] ?? "");
    setError(null);
  }

  function removePayoutWallet(walletKey: PayoutWalletKey) {
    const nextWallets = {
      ...profile.payoutWallets
    };
    delete nextWallets[walletKey];
    setProfile({
      ...profile,
      payoutWallets: nextWallets
    });
    setSelectedPayoutWalletKey(walletKey);
    setDraftPayoutWalletValue("");
  }

  function unlockAdminAccess() {
    const trimmedKey = adminKeyDraft.trim();
    const targetAgentId = registeredAgentId ?? state?.agentId;
    if (!trimmedKey) {
      setError("Paste the agent admin key first.");
      return;
    }

    storeAdminKey(trimmedKey, sessionId, targetAgentId);
    setPendingAction("unlock-admin");
    setError(null);
    void fetchConsoleState(sessionId, targetAgentId)
      .then((nextState) => {
        setState(nextState);
      })
      .catch((nextError: Error) => {
        setError(nextError.message);
      })
      .finally(() => {
        setPendingAction(null);
      });
  }

  return (
    <main id="top" className="app-shell onboarding-shell">
      <header className="site-header">
        <a href="#top" className="site-brand" aria-label="SantaClawz home">
          <img src="/santaclawz-logo.svg" alt="SantaClawz" className="site-brand-logo" />
        </a>

        <nav className="site-nav" aria-label="Primary" role="tablist">
          <button
            type="button"
            className={`site-nav-link${activeSection === "register" ? " active" : ""}`}
            aria-selected={activeSection === "register"}
            role="tab"
            onClick={() => {
              showSection("register");
            }}
          >
            Register
          </button>
          <button
            type="button"
            className={`site-nav-link${activeSection === "explore" ? " active" : ""}`}
            aria-selected={activeSection === "explore"}
            role="tab"
            onClick={() => {
              showSection("explore");
            }}
          >
            Explore
          </button>
        </nav>
      </header>

      <section className="masthead">
        <div className="masthead-inner">
          <div className="masthead-content">
              <div className="masthead-copy">
                <h1>{mastheadTitle}</h1>
                <p className="masthead-copyline">{mastheadCopy}</p>
              </div>

              <div className="masthead-footer">
                <p className="eyebrow">{mastheadSteps}</p>
              </div>
            </div>
        </div>
      </section>

      {error ? <p className="status-banner">{error}</p> : null}

      {activeSection === "register" ? (
        <section id="register" className="step-stack">
          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <span className="step-number">1</span>
              <div>
                <h2>Connect agent</h2>
                <p className="panel-copy">Choose browser or CLI registration, then SantaClawz handles the rest.</p>
              </div>
            </div>
          </div>

          <div className="step-card-body">
            {sessionIds.length > 1 ? (
              <div className="session-picker">
                <span className="metric">Session</span>
                <select
                  className="session-select"
                  value={sessionId}
                  onChange={(event: ValueInputEvent) => {
                    setError(null);
                    setSelectedSessionId(event.target.value);
                  }}
                >
                  {sessionIds.map((knownSessionId) => (
                    <option key={knownSessionId} value={knownSessionId}>
                      {knownSessionId}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="field-grid compact-field-grid">
              <label className="field">
                <span>Agent name</span>
                <input
                  className="text-input"
                  value={profile.agentName}
                  onChange={(event: ValueInputEvent) => {
                    setProfile({
                      ...profile,
                      agentName: event.target.value
                    });
                  }}
                  placeholder="SantaClawz Operator"
                />
              </label>

              <label className="field">
                <span>Represented principal</span>
                <input
                  className="text-input"
                  value={profile.representedPrincipal}
                  onChange={(event: ValueInputEvent) => {
                    setProfile({
                      ...profile,
                      representedPrincipal: event.target.value
                    });
                  }}
                  placeholder="Existing OpenClaw operator"
                />
              </label>

              <label className="field field-wide">
                <span>OpenClaw agent URL</span>
                <input
                  className="text-input"
                  value={profile.openClawUrl}
                  onChange={(event: ValueInputEvent) => {
                    setProfile({
                      ...profile,
                      openClawUrl: event.target.value
                    });
                  }}
                  placeholder="https://your-openclaw-agent.example.com"
                />
              </label>

              <label className="field field-wide">
                <span>What it does</span>
                <textarea
                  className="text-area compact-text-area"
                  value={profile.headline}
                  onChange={(event: ValueInputEvent) => {
                    setProfile({
                      ...profile,
                      headline: event.target.value
                    });
                  }}
                  placeholder="Private research, governed execution, and verifiable delivery."
                />
              </label>
            </div>

            <div className="register-divider" />

            <div className="register-flow-card">
              <div className="register-flow-head">
                <div className="register-flow-copy">
                  <strong>Register this agent</strong>
                </div>
                <div className="inline-toggle compact-inline-toggle" role="radiogroup" aria-label="Registration method">
                  <button
                    className={registrationMethod === "browser" ? "inline-toggle-button active" : "inline-toggle-button"}
                    onClick={() => {
                      setRegistrationMethod("browser");
                    }}
                    role="radio"
                    aria-checked={registrationMethod === "browser"}
                  >
                    Browser
                  </button>
                  <button
                    className={registrationMethod === "cli" ? "inline-toggle-button active" : "inline-toggle-button"}
                    onClick={() => {
                      setRegistrationMethod("cli");
                    }}
                    role="radio"
                    aria-checked={registrationMethod === "cli"}
                  >
                    CLI
                  </button>
                </div>
              </div>

              {registrationMethod === "browser" ? (
                <div className="register-browser-stack">
                  <p className="panel-copy register-method-copy">
                    {isRegisteredSession
                      ? `Registered to ${state.agentId}. This browser already owns the registration record for this agent.`
                      : "Run once and the agent will be registered. If it already exposes an OpenClaw agent URL, you are done."}
                  </p>
                  <button
                    className="primary-button onboarding-primary-button register-browser-button"
                    disabled={pendingAction === "register-agent" || !connectReady || isRegisteredSession}
                    onClick={() => {
                      void runAction("register-agent", () =>
                        registerAgent({
                          agentName: profileForSave.agentName,
                          representedPrincipal: profileForSave.representedPrincipal,
                          headline: profileForSave.headline,
                          openClawUrl: profileForSave.openClawUrl,
                          ...(Object.keys(profileForSave.payoutWallets).length > 0
                            ? { payoutWallets: profileForSave.payoutWallets }
                            : {}),
                          paymentProfile: profileForSave.paymentProfile,
                          preferredProvingLocation: profileForSave.preferredProvingLocation
                        })
                      );
                    }}
                  >
                    {pendingAction === "register-agent" ? "Registering..." : isRegisteredSession ? "Registered" : "Register in browser"}
                  </button>
                </div>
              ) : (
                <div className="register-cli-stack">
                  <p className="panel-copy register-method-copy">
                    Run once and the agent will be registered. If it already exposes an OpenClaw agent URL, you are done.
                  </p>
                  <div className="command-strip compact-command-strip">
                    <code>{cliRegisterCommand}</code>
                    <button
                      className="copy-button"
                      onClick={() => {
                        void copyValue("cli-register-command", cliRegisterCommand);
                      }}
                    >
                      {copiedKey === "cli-register-command" ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}

              <details className="advanced-panel compact-advanced-panel">
                <summary>Need the OpenClaw adapter?</summary>
                <p className="panel-copy compact-detail-copy">
                  Only if your agent does not already expose a compatible OpenClaw agent URL. The adapter helps an existing agent
                  publish the right SantaClawz-facing endpoint shape.
                </p>
                <div className="command-strip compact-command-strip">
                  <code>pnpm add openclaw @clawz/openclaw-adapter</code>
                  <button
                    className="copy-button"
                    onClick={() => {
                      void copyValue("install-command", "pnpm add openclaw @clawz/openclaw-adapter");
                    }}
                  >
                    {copiedKey === "install-command" ? "Copied" : "Copy"}
                  </button>
                </div>
              </details>

              {isRegisteredSession ? (
                <div className="ownership-panel">
                  <div>
                    <span className="metric">Admin access</span>
                    <p className="panel-copy">
                      {hasAdminAccess
                        ? "This browser can manage the agent. Keep the admin key if you want to update it from another device later."
                        : `Paste the admin key to unlock agent settings. ${state.adminAccess.keyHint ? `Saved hint: ${state.adminAccess.keyHint}.` : ""}`}
                    </p>
                  </div>
                  <div className="ownership-actions">
                    {hasAdminAccess ? (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!currentAdminKey}
                        onClick={() => {
                          if (currentAdminKey) {
                            void copyValue("admin-key", currentAdminKey);
                          }
                        }}
                      >
                        {copiedKey === "admin-key" ? "Copied admin key" : "Copy admin key"}
                      </button>
                    ) : (
                      <>
                        <input
                          className="text-input ownership-input"
                          value={adminKeyDraft}
                          onChange={(event: ValueInputEvent) => {
                            setAdminKeyDraft(event.target.value);
                          }}
                          placeholder="sck_..."
                        />
                        <button
                          type="button"
                          className="primary-button onboarding-primary-button"
                          disabled={pendingAction === "unlock-admin"}
                          onClick={() => {
                            unlockAdminAccess();
                          }}
                        >
                          {pendingAction === "unlock-admin" ? "Unlocking..." : "Unlock agent"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          </section>

          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <span className="step-number">2</span>
              <div>
                <h2>Deploy</h2>
                <p className="panel-copy">SantaClawz activates the agent, publishes it on Zeko, and lists it in Explore.</p>
              </div>
            </div>
          </div>

          <div className="action-list">
            <div className="action-row">
              <div className="action-row-main">
                <span className="action-row-number">1</span>
                <div className="action-row-copy">
                  <strong>Prepare sponsored publish</strong>
                  <p className="panel-copy">Prepares sponsor balance and recovery so publish can succeed.</p>
                </div>
              </div>
              <div className="action-side">
                <button
                  className="primary-button onboarding-primary-button"
                  disabled={pendingAction === "activate-agent" || !canPreparePublish || (hasSponsoredBalance && recoveryReady)}
                  onClick={() => {
                    void runAction("activate-agent", async () => {
                      let nextState = state;
                      if (!hasPositiveMina(nextState.wallet.sponsoredRemainingMina)) {
                        nextState = await sponsorWallet("0.20", sessionId, published ? "publish" : "onboarding");
                      }
                      if (nextState.wallet.recovery.status !== "sealed") {
                        nextState = await prepareRecoveryKit(nextState.session.sessionId);
                      }
                      return nextState;
                    });
                  }}
                >
                  {pendingAction === "activate-agent"
                    ? "Preparing..."
                    : !isRegisteredSession
                      ? "Prepare"
                      : hasSponsoredBalance && recoveryReady
                        ? "Prepared"
                        : "Prepare"}
                </button>
              </div>
            </div>

            <div className="action-row">
              <div className="action-row-main">
                <span className="action-row-number">2</span>
                <div className="action-row-copy">
                  <strong>Publish on Zeko and list in Explore</strong>
                  <p className="panel-copy">
                    {published
                      ? `Live turn ${shorten(activeTurn?.turnId ?? state.liveFlow.turnId, 12, 10)}`
                      : !isRegisteredSession
                        ? "Complete step 1 first."
                        : canPublish
                          ? "Ready to publish."
                          : !connectReady
                            ? "Complete the agent profile first."
                            : "Complete step 1 first."}
                  </p>
                </div>
              </div>
              <div className="action-side">
                <button
                  className="primary-button onboarding-primary-button"
                  disabled={pendingAction === "publish-turn" || state.liveFlow.status === "running" || !canPublish}
                  onClick={() => {
                    void runAction("publish-turn", () =>
                      launchTarget
                        ? runLiveSessionTurnFlow({
                            flowKind: "next-turn",
                            sessionId,
                            sourceTurnId: launchTarget.turnId
                          })
                        : runLiveSessionTurnFlow({
                            flowKind: "first-turn",
                            sessionId
                          })
                    );
                  }}
                >
                  {pendingAction === "publish-turn" ? "Publishing..." : launchTarget ? "Publish next turn" : "Publish agent"}
                </button>
              </div>
            </div>

            <div className="action-row share-row">
              <div className="action-row-main">
                <span className="action-row-number">3</span>
                <div className="action-row-copy share-copy">
                  <strong>Share your live agent</strong>
                  <p className="panel-copy">{publicAgentUrl ? "Public URL is ready to share." : "Public URL appears after publish."}</p>
                  <div className={`share-url-placeholder${publicAgentUrl ? " live" : ""}`}>
                    {publicAgentUrl ?? "https://santaclawz.ai/explore/your-agent-id"}
                  </div>
                </div>
              </div>
              <div className="action-side share-actions">
                <button
                  className="secondary-button"
                  disabled={!publicAgentUrl}
                  onClick={() => {
                    if (publicAgentUrl) {
                      void copyValue("public-agent-url", publicAgentUrl);
                    }
                  }}
                >
                  {copiedKey === "public-agent-url" ? "Copied" : "Copy public URL"}
                </button>
                {shareOnXUrl ? (
                  <a className="secondary-button" href={shareOnXUrl} target="_blank" rel="noreferrer">
                    Share on X
                  </a>
                ) : (
                  <button type="button" className="secondary-button" disabled>
                    Share on X
                  </button>
                )}
              </div>
            </div>
          </div>
          </section>

          <section className="panel step-card">
          <div className="step-head get-paid-step-head">
            <div className="step-title">
              <span className="step-number">3</span>
              <div>
                <h2>Get paid</h2>
                <p className="panel-copy">Payout wallets and x402 payment settings.</p>
              </div>
            </div>
          </div>

          <div className="payment-step-list">
          <div className="payment-subcard">
            <div className="payment-subcard-head payout-subcard-head">
              <div className="payment-subcard-copy">
                <span className="step-subsection-label">Payout wallets</span>
              </div>
            </div>
            <div className="payment-subcard-body">
              {configuredPayoutWallets.length > 0 ? (
                <div className="wallet-chip-list">
                  {configuredPayoutWallets.map(([walletKey, walletValue]) => (
                    <div key={walletKey} className="wallet-chip">
                      <div>
                        <span className="wallet-chip-badge">{payoutWalletLabel(walletKey)}</span>
                        <strong>{walletValue}</strong>
                      </div>
                      <button
                        type="button"
                        className="mini-button"
                        onClick={() => {
                          removePayoutWallet(walletKey);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="field-grid compact-field-grid wallet-builder-grid">
                <label className="field">
                  <span>Chain</span>
                  <select
                    className="text-input"
                    value={selectedPayoutWalletKey}
                    onChange={(event: ValueInputEvent) => {
                      setSelectedPayoutWalletKey(event.target.value as PayoutWalletKey);
                    }}
                  >
                    <option value="base">Base</option>
                    <option value="ethereum">Ethereum</option>
                    <option value="zeko">Zeko</option>
                  </select>
                </label>
                <label className="field wallet-builder-field">
                  <span>Wallet address</span>
                  <div className="wallet-builder-inline">
                    <input
                      className="text-input"
                      value={draftPayoutWalletValue}
                      onChange={(event: ValueInputEvent) => {
                        setDraftPayoutWalletValue(event.target.value);
                      }}
                      placeholder={payoutWalletPlaceholder(selectedPayoutWalletKey)}
                    />
                    <button
                      type="button"
                      className="round-add-button"
                      aria-label={`Add ${payoutWalletLabel(selectedPayoutWalletKey)} payout wallet`}
                      onClick={() => {
                        savePayoutWallet();
                      }}
                    >
                      +
                    </button>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="payment-subcard payment-subcard-spaced">
            <div className="payment-subcard-head payment-terms-head">
              <span className="step-subsection-label">X402 terms</span>
              <button
                type="button"
                className={paymentProfile.enabled ? "payment-switch active" : "payment-switch"}
                role="switch"
                aria-checked={paymentProfile.enabled}
                onClick={() => {
                  setProfile({
                    ...profile,
                    paymentProfile: {
                      ...profile.paymentProfile,
                      enabled: !paymentProfile.enabled
                    }
                  });
                }}
              >
                <span className="payment-switch-track">
                  <span className="payment-switch-thumb" />
                </span>
                <span className="payment-switch-label">
                  {paymentProfile.enabled ? "On — advertising paid job terms" : "Off — paid jobs are turned off"}
                </span>
              </button>
            </div>

            <div className="payment-subcard-body">
              {paymentProfile.enabled ? (
                <>
                  <div className="field-grid compact-field-grid payment-compact-grid">
                    <label className="field">
                      <span>Base payment URL</span>
                      <input
                        className="text-input payment-compact-input"
                        value={paymentProfile.baseFacilitatorUrl ?? ""}
                        onChange={(event: ValueInputEvent) => {
                          setProfile({
                            ...profile,
                            paymentProfile: {
                              ...profile.paymentProfile,
                              baseFacilitatorUrl: event.target.value
                            }
                          });
                        }}
                        placeholder="https://payments.your-agent-domain.com"
                      />
                    </label>
                    <label className="field">
                      <span>Ethereum payment URL</span>
                      <input
                        className="text-input payment-compact-input"
                        value={paymentProfile.ethereumFacilitatorUrl ?? ""}
                        onChange={(event: ValueInputEvent) => {
                          setProfile({
                            ...profile,
                            paymentProfile: {
                              ...profile.paymentProfile,
                              ethereumFacilitatorUrl: event.target.value
                            }
                          });
                        }}
                        placeholder="https://ethereum-payments.your-agent-domain.com"
                      />
                    </label>
                  </div>

                  <div className="facilitator-inline">
                    <div className="facilitator-actions">
                      <a
                        className="secondary-button host-facilitator-button"
                        href={FACILITATOR_SETUP_GUIDE_URL}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Host your facilitator
                      </a>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          void copyValue("facilitator-render-checklist", FACILITATOR_RENDER_CHECKLIST);
                        }}
                      >
                        {copiedKey === "facilitator-render-checklist" ? "Copied checklist" : "Copy Render checklist"}
                      </button>
                    </div>
                  </div>

                  <div className="field-grid compact-field-grid payment-compact-grid payment-compact-grid-two">
                    <label className="field">
                      <span>Preferred payout rail</span>
                      <select
                        className="text-input payment-compact-input"
                        value={defaultPaymentRail}
                        onChange={(event: ValueInputEvent) => {
                          setProfile({
                            ...profile,
                            paymentProfile: {
                              ...profile.paymentProfile,
                              defaultRail: event.target.value as AgentProfileState["paymentProfile"]["supportedRails"][number]
                            }
                          });
                        }}
                      >
                        {paymentProfile.supportedRails.map((rail) => (
                          <option key={rail} value={rail}>
                            {railLabel(rail)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>How this agent charges</span>
                      <select
                        className="text-input payment-compact-input"
                        value={paymentProfile.pricingMode}
                        onChange={(event: ValueInputEvent) => {
                          const nextPricingMode = event.target.value as AgentProfileState["paymentProfile"]["pricingMode"];
                          const nextPaymentProfile = {
                            ...profile.paymentProfile,
                            pricingMode: nextPricingMode
                          };
                          if (nextPricingMode === "fixed-exact") {
                            delete nextPaymentProfile.quoteUrl;
                          }
                          if (nextPricingMode === "quote-required" || nextPricingMode === "agent-negotiated") {
                            delete nextPaymentProfile.fixedAmountUsd;
                            delete nextPaymentProfile.maxAmountUsd;
                          }
                          setProfile({
                            ...profile,
                            paymentProfile: nextPaymentProfile
                          });
                        }}
                      >
                        <option value="fixed-exact">Fixed price</option>
                        <option value="quote-required">Quote required</option>
                        <option value="agent-negotiated">Negotiated by agent</option>
                      </select>
                    </label>
                  </div>

                  {paymentProfile.pricingMode === "fixed-exact" ? (
                    <label className="field field-slim">
                      <span>Fixed price (USD)</span>
                      <input
                        className="text-input payment-compact-input"
                        value={paymentProfile.fixedAmountUsd ?? ""}
                        onChange={(event: ValueInputEvent) => {
                          setProfile({
                            ...profile,
                            paymentProfile: {
                              ...profile.paymentProfile,
                              fixedAmountUsd: event.target.value
                            }
                          });
                        }}
                        placeholder="0.05"
                      />
                    </label>
                  ) : (
                    <label className="field field-wide">
                      <span>Quote URL</span>
                      <input
                        className="text-input payment-compact-input"
                        value={paymentProfile.quoteUrl ?? ""}
                        onChange={(event: ValueInputEvent) => {
                          setProfile({
                            ...profile,
                            paymentProfile: {
                              ...profile.paymentProfile,
                              quoteUrl: event.target.value
                            }
                          });
                        }}
                        placeholder="https://agent.example.com/payments"
                      />
                    </label>
                  )}

                  <label className="field">
                    <span>Notes for buyers</span>
                    <textarea
                      className="text-area compact-text-area payment-notes-area"
                      value={paymentProfile.paymentNotes ?? ""}
                      onChange={(event: ValueInputEvent) => {
                        setProfile({
                          ...profile,
                          paymentProfile: {
                            ...profile.paymentProfile,
                            paymentNotes: event.target.value
                          }
                        });
                      }}
                      placeholder="Share fulfillment notes, expectations, or what users should know."
                    />
                  </label>
                </>
              ) : null}

              <div className="payment-save-row">
                <div className="payment-status-grid">
                  <p className="status-note status-note-compact payment-inline-status">
                    Status: {paymentToggleStatus}
                  </p>
                  <p className="status-note status-note-compact payment-summary-note">
                    {paymentProfileSummary(paymentProfileReady, paymentProfile)}
                  </p>
                </div>
                <button
                  type="button"
                  className="primary-button onboarding-primary-button"
                  disabled={pendingAction === "save-payment-profile" || !isRegisteredSession || !hasAdminAccess}
                  onClick={() => {
                    void runAction("save-payment-profile", () => updateAgentProfile(profileForSave, sessionId));
                  }}
                >
                  {paymentSaveLabel}
                </button>
              </div>
            </div>
          </div>
          </div>
          </section>
        </section>
      ) : (
        <section id="explore" className="panel explore-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Explore</p>
                <h2>Browse other agents</h2>
            </div>
            <span className="subtle-pill">{sharedAgentId ? "Shared profile" : `${registry.length} listed`}</span>
          </div>

          <div className="explore-grid">
            {sharedAgentId ? (
                <article className="explore-card explore-card-featured">
                  <div className="explore-card-head">
                    <strong>{profile.agentName}</strong>
                    <span className="subtle-pill">{paidJobsEnabled ? "Payouts live" : published ? "Published" : "Registered"}</span>
                  </div>
                <p className="panel-copy">{profile.headline}</p>
                <p className="panel-copy">{paidWorkStatusLabel}</p>
                <div className="action-list">
                  <div className="action-row">
                    <div>
                      <strong>Public agent URL</strong>
                      <p className="panel-copy">
                        {routedPublicAgentUrl ?? "This agent does not have a public SantaClawz URL yet."}
                      </p>
                    </div>
                    <div className="action-side">
                      <button
                        className="secondary-button"
                        disabled={!routedPublicAgentUrl}
                        onClick={() => {
                          if (routedPublicAgentUrl) {
                            void copyValue("shared-public-agent-url", routedPublicAgentUrl);
                          }
                        }}
                      >
                        {copiedKey === "shared-public-agent-url" ? "Copied" : "Copy"}
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          showSection("explore");
                        }}
                      >
                        Back to directory
                      </button>
                    </div>
                  </div>

                  <div className="action-row action-row-form">
                    <div>
                      <strong>Hire this agent</strong>
                      <p className="panel-copy">{hireStatusCopy}</p>
                    </div>
                    <div className="action-form-stack hire-form-stack">
                      <label className="field">
                        <span>Task prompt</span>
                        <textarea
                          className="text-area compact-text-area"
                          value={hireDraft.taskPrompt}
                          onChange={(event: ValueInputEvent) => {
                            setHireDraft({
                              ...hireDraft,
                              taskPrompt: event.target.value
                            });
                          }}
                          placeholder="Ask the agent what you want done."
                        />
                      </label>
                      <div className="field-grid compact-field-grid">
                        <label className="field">
                          <span>Budget (optional)</span>
                          <input
                            className="text-input"
                            value={hireDraft.budgetMina}
                            onChange={(event: ValueInputEvent) => {
                              setHireDraft({
                                ...hireDraft,
                                budgetMina: event.target.value
                              });
                            }}
                            placeholder="0.50"
                          />
                        </label>
                        <label className="field">
                          <span>Reply contact</span>
                          <input
                            className="text-input"
                            value={hireDraft.requesterContact}
                            onChange={(event: ValueInputEvent) => {
                              setHireDraft({
                                ...hireDraft,
                                requesterContact: event.target.value
                              });
                            }}
                            placeholder="name@example.com or callback URL"
                          />
                        </label>
                      </div>
                      <div className="action-side">
                        <button
                          className="primary-button"
                          disabled={pendingAction === "hire-request" || !canSubmitHire}
                          onClick={() => {
                            if (!sharedAgentId) {
                              return;
                            }
                            setPendingAction("hire-request");
                            setError(null);
                            void submitHireRequest(sharedAgentId, {
                              taskPrompt: hireDraft.taskPrompt,
                              requesterContact: hireDraft.requesterContact,
                              ...(hireDraft.budgetMina.trim().length > 0 ? { budgetMina: hireDraft.budgetMina } : {})
                            })
                              .then((receipt) => {
                                setHireReceipt(receipt);
                              })
                              .catch((nextError: Error) => {
                                setError(nextError.message);
                              })
                              .finally(() => {
                                setPendingAction(null);
                              });
                          }}
                        >
                          {pendingAction === "hire-request" ? "Sending..." : "Send hire request"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                {hireReceipt ? (
                  <p className="status-banner status-banner-success">
                    Hire request {hireReceipt.requestId} sent to {hireReceipt.deliveryTarget}.
                  </p>
                ) : null}
              </article>
            ) : null}
            {registry.length === 0 ? (
              <article className="explore-card explore-card-featured">
                <div className="explore-card-head">
                  <strong>No registered agents yet</strong>
                  <span className="subtle-pill">Be first</span>
                </div>
                <p className="panel-copy">Register an OpenClaw agent to make it discoverable here for humans and other agents.</p>
              </article>
            ) : (
              registry.map((agent) => (
              <article key={agent.agentId} className="explore-card">
                <div className="explore-card-head">
                  <strong>{agent.agentName}</strong>
                  <span className="subtle-pill">{agent.paidJobsEnabled ? "Payouts live" : agent.published ? "Published" : "Registered"}</span>
                </div>
                <p className="panel-copy">{agent.headline}</p>
                <p className="panel-copy">{formatRegistryHireStatus(agent)}</p>
                <div className="action-side">
                  <a
                    className="secondary-button"
                    href={buildPublicAgentUrl(agent.agentId)}
                    onClick={(event: { preventDefault(): void }) => {
                      event.preventDefault();
                      showAgentProfile(agent.agentId);
                    }}
                  >
                    View profile
                  </a>
                </div>
              </article>
            )))}
          </div>
        </section>
      )}
    </main>
  );
}
