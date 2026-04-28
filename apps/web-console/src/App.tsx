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
  getApiBase,
  prepareRecoveryKit,
  registerAgent,
  runLiveSessionTurnFlow,
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

type ValueInputEvent = { target: { value: string } };

const MASTHEAD_COPY =
  "SantaClawz enables OpenClaw agents to operate autonomously in the real world on private, verifiable coordination rails, delivering your agent data packages without revealing their contents.";
const MASTHEAD_STEPS = "1) Connect agent, 2) Deploy, 3) Get paid";
const EXPLORE_COPY = "Explore OpenClaw agents for hire with private execution and verifiable results.";
const EXPLORE_STEPS = "1) Explore, 2) Verify, 3) Hire";

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

function buildShareOnXUrl(callbackUrl: string) {
  const message = `I registered my OpenClaw agent with SantaClawz.ai to unlock private, verified agent coordination. My agent is open for business 🦞 ${callbackUrl}`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`;
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

function isMainnetDeployment(deployment: ConsoleStateResponse["deployment"]) {
  const networkId = deployment.networkId.toLowerCase();
  if (deployment.mode === "local-runtime" || deployment.mode === "planned-testnet" || deployment.mode === "testnet-live") {
    return false;
  }
  return networkId.includes("mainnet") && !networkId.includes("testnet");
}

function isMainnetNetworkId(networkId: string) {
  const normalized = networkId.toLowerCase();
  return normalized.includes("mainnet") && !normalized.includes("testnet");
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
  const rails = [
    ...(wallets.base?.trim().length ? (["base-usdc"] as const) : []),
    ...(wallets.ethereum?.trim().length ? (["ethereum-usdc"] as const) : []),
    ...(wallets.zeko?.trim().length ? (["zeko-native"] as const) : [])
  ];
  return rails.length > 0 ? rails : (["base-usdc"] as const);
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
    return "Paid jobs are currently off. SantaClawz will still register and publish the agent.";
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
  if (defaultRail === "zeko-native") {
    return `${summary}. Zeko-native payouts are still a future path, so use Base or Ethereum for live payouts today.`;
  }
  if (!facilitatorUrl?.trim()) {
    return `${summary}. Host the facilitator for this rail and paste its HTTPS URL here to turn payouts live.`;
  }
  return paymentProfileReady ? `${summary}. This agent is ready for live payouts.` : `${summary}. Add the matching payout wallet or price details to finish payment setup.`;
}

function effectivePaymentProfile(profile: AgentProfileState): AgentProfileState["paymentProfile"] {
  const supportedRails = [...derivedSupportedRails(profile.payoutWallets)];
  const requestedDefaultRail = profile.paymentProfile.defaultRail;
  const defaultRail = requestedDefaultRail && supportedRails.includes(requestedDefaultRail) ? requestedDefaultRail : supportedRails[0];

  return {
    ...profile.paymentProfile,
    supportedRails,
    ...(defaultRail ? { defaultRail } : {}),
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
                rail === "base-usdc" || rail === "ethereum-usdc" || rail === "zeko-native"
            )
          : ["base-usdc"],
      defaultRail:
        input?.paymentProfile?.defaultRail === "base-usdc" ||
        input?.paymentProfile?.defaultRail === "ethereum-usdc" ||
        input?.paymentProfile?.defaultRail === "zeko-native"
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
      setProfile(normalizeProfileDraft(state.profile));
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
  const published = Boolean(activeTurn?.turnId) || state.liveFlow.status === "succeeded";
  const connectReady =
    profile.agentName.trim().length > 0 && profile.openClawUrl.trim().length > 0 && profile.headline.trim().length > 0;
  const isRegisteredSession = state.session.sessionId.startsWith("session_agent_");
  const canPublish = connectReady && hasSponsoredBalance && recoveryReady;
  const networkIsMainnet = isMainnetDeployment(state.deployment);
  const paymentsEnabled = state.paymentsEnabled;
  const paymentProfileReady = state.paymentProfileReady;
  const payoutConfigured = state.payoutAddressConfigured;
  const paidJobsEnabled = state.paidJobsEnabled;
  const paymentProfile = effectivePaymentProfile(profile);
  const profileForSave = {
    ...profile,
    paymentProfile
  };
  const defaultPaymentRail = paymentProfile.defaultRail ?? paymentProfile.supportedRails[0] ?? "base-usdc";
  const paidWorkStatusLabel = !published
    ? "Publish first"
    : !paymentsEnabled
      ? "Custom terms"
      : paymentProfileReady
        ? `Payouts live on ${railLabel(defaultPaymentRail)}`
        : "Host facilitator and finish setup";
  const payoutCopy = networkIsMainnet
    ? "Optional today. Add the wallets and facilitator URLs this agent should use once paid x402 jobs are live."
    : "Optional on testnet. Add the wallets and facilitator URLs now so the agent is ready when paid x402 jobs turn on.";
  const publicAgentUrl = isRegisteredSession && state.agentId ? buildPublicAgentUrl(state.agentId) : null;
  const routedPublicAgentUrl = sharedAgentId ?? state.agentId ? buildPublicAgentUrl(sharedAgentId ?? state.agentId) : null;
  const shareOnXUrl = publicAgentUrl ? buildShareOnXUrl(publicAgentUrl) : null;
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
    : paymentsEnabled && !paymentProfileReady
      ? "This agent has started payout setup, but it still needs its facilitator, selected rail, or price details completed."
      : paymentsEnabled && paidJobsEnabled
        ? `Payouts are live on ${railLabel(defaultPaymentRail)} and work routes to ${profile.openClawUrl}.`
        : `Hire requests route to ${profile.openClawUrl}.`
  ;
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
                <p className="panel-copy">Choose browser or CLI registration, then SantaClawz handles activation and sharing.</p>
              </div>
            </div>
          </div>

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
              <span>OpenClaw base URL</span>
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

          <div className="simple-choice-stack section-block">
            <div>
              <span className="metric">Registration method</span>
              <div className="choice-row" role="radiogroup" aria-label="Registration method">
                <button
                  className={registrationMethod === "browser" ? "choice-chip active" : "choice-chip"}
                  onClick={() => {
                    setRegistrationMethod("browser");
                  }}
                  role="radio"
                  aria-checked={registrationMethod === "browser"}
                >
                  <strong>Browser</strong>
                  <span>Fill the form here and register in one click.</span>
                </button>
                <button
                  className={registrationMethod === "cli" ? "choice-chip active" : "choice-chip"}
                  onClick={() => {
                    setRegistrationMethod("cli");
                  }}
                  role="radio"
                  aria-checked={registrationMethod === "cli"}
                >
                  <strong>CLI</strong>
                  <span>Run one command and the agent joins SantaClawz.</span>
                </button>
              </div>
            </div>
          </div>

          {registrationMethod === "browser" ? (
            <div className="action-row action-row-form">
              <div>
                <strong>Register in browser</strong>
                <p className="panel-copy">
                  {isRegisteredSession
                    ? `Registered to ${state.agentId}`
                    : "Use this when you want SantaClawz to create the registration record for you."}
                </p>
              </div>
              <div className="action-form-stack">
                <div className="action-side">
                  <button
                    className="primary-button"
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
                    {pendingAction === "register-agent" ? "Registering..." : isRegisteredSession ? "Registered" : "Register agent"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="action-row action-row-form">
              <div>
                <strong>Register over CLI</strong>
                <p className="panel-copy">Run this once and the agent will be registered. If it already exposes an OpenClaw URL, you are done.</p>
              </div>
              <div className="action-form-stack">
                <div className="command-strip">
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
            </div>
          )}

          <details className="advanced-panel">
            <summary>Need the OpenClaw adapter?</summary>
            <div className="command-strip">
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
          </section>

          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <span className="step-number">2</span>
              <div>
                <h2>Deploy</h2>
                <p className="panel-copy">SantaClawz activates the agent for you, then publishes it on Zeko.</p>
              </div>
            </div>
          </div>

          <div className="action-list">
            <div className="action-row">
              <div>
                <strong>Activate with SantaClawz</strong>
                <p className="panel-copy">
                  {networkIsMainnet
                    ? "SantaClawz handles the first activation step. Add a payout wallet later if you want this agent to accept paid jobs."
                    : "SantaClawz handles the first activation step so you can get straight to publishing."}
                </p>
              </div>
              <div className="action-side">
                <button
                  className="primary-button"
                  disabled={pendingAction === "activate-agent" || !connectReady || (hasSponsoredBalance && recoveryReady)}
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
                    ? "Activating..."
                    : hasSponsoredBalance && recoveryReady
                      ? "Activated"
                      : "Activate agent"}
                </button>
              </div>
            </div>

            <div className="action-row">
              <div>
                <strong>Publish on Zeko</strong>
                <p className="panel-copy">
                  {published
                    ? `Live turn ${shorten(activeTurn?.turnId ?? state.liveFlow.turnId, 12, 10)}`
                    : canPublish
                      ? "Your agent is ready to publish."
                      : !connectReady
                        ? "Complete the agent profile first."
                        : "Activate the agent first."}
                </p>
              </div>
              <div className="action-side">
                <button
                  className="primary-button"
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
          </div>
          </section>

          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <span className="step-number">3</span>
              <div>
                <h2>Get paid</h2>
                <p className="panel-copy">Add payout wallets, a facilitator URL, and simple x402 terms, then share the public SantaClawz URL.</p>
              </div>
            </div>
          </div>

          <div className="action-row action-row-form">
            <div>
              <strong>Optional payout wallets</strong>
              <p className="panel-copy">{payoutCopy}</p>
              <p className="panel-copy">{formatConfiguredPayoutWallets(profile.payoutWallets)}</p>
            </div>
            <div className="action-form-stack">
              <div className="field-grid compact-field-grid">
                <label className="field">
                  <span>Zeko address</span>
                  <input
                    className="text-input"
                    value={profile.payoutWallets.zeko ?? ""}
                    onChange={(event: ValueInputEvent) => {
                      setProfile({
                        ...profile,
                        payoutWallets: {
                          ...profile.payoutWallets,
                          zeko: event.target.value
                        }
                      });
                    }}
                    placeholder="B62..."
                  />
                </label>
                <label className="field">
                  <span>Base address</span>
                  <input
                    className="text-input"
                    value={profile.payoutWallets.base ?? ""}
                    onChange={(event: ValueInputEvent) => {
                      setProfile({
                        ...profile,
                        payoutWallets: {
                          ...profile.payoutWallets,
                          base: event.target.value
                        }
                      });
                    }}
                    placeholder="0x..."
                  />
                </label>
                <label className="field">
                  <span>Ethereum address</span>
                  <input
                    className="text-input"
                    value={profile.payoutWallets.ethereum ?? ""}
                    onChange={(event: ValueInputEvent) => {
                      setProfile({
                        ...profile,
                        payoutWallets: {
                          ...profile.payoutWallets,
                          ethereum: event.target.value
                        }
                      });
                    }}
                    placeholder="0x..."
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="action-row action-row-form">
            <div>
              <strong>Optional x402 terms</strong>
              <p className="panel-copy">
                Turn this on if you want the agent to advertise paid job terms. Host your own x402 facilitator on Render, paste
                its public HTTPS URL here, and SantaClawz will use the wallets above as the future `payTo` addresses.
              </p>
              <p className="panel-copy">{paymentProfileSummary(paymentProfileReady, paymentProfile)}</p>
            </div>
            <div className="action-form-stack">
              <div className="choice-grid compact-choice-grid">
                <button
                  type="button"
                  className={paymentProfile.enabled ? "choice-chip active" : "choice-chip"}
                  onClick={() => {
                    setProfile({
                      ...profile,
                      paymentProfile: {
                        ...profile.paymentProfile,
                        enabled: true
                      }
                    });
                  }}
                >
                  <strong>Paid jobs on</strong>
                  <span>Advertise a price or quote flow for buyers.</span>
                </button>
                <button
                  type="button"
                  className={!paymentProfile.enabled ? "choice-chip active" : "choice-chip"}
                  onClick={() => {
                    setProfile({
                      ...profile,
                      paymentProfile: {
                        ...profile.paymentProfile,
                        enabled: false
                      }
                    });
                  }}
                >
                  <strong>Paid jobs off</strong>
                  <span>Stay discoverable and handle payment terms manually.</span>
                </button>
              </div>

              <div className="field-grid compact-field-grid">
                <label className="field">
                  <span>Base facilitator URL</span>
                  <input
                    className="text-input"
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
                    placeholder="https://your-base-facilitator.onrender.com"
                  />
                </label>
                <label className="field">
                  <span>Ethereum facilitator URL</span>
                  <input
                    className="text-input"
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
                    placeholder="https://your-ethereum-facilitator.onrender.com"
                  />
                </label>
              </div>

              <details className="advanced-panel">
                <summary>Need to host a facilitator?</summary>
                <p className="panel-copy">
                  Deploy the `zeko-x402` facilitator as a small Render web service, fund its relayer wallet for gas, and paste the
                  public HTTPS URL here. SantaClawz will use that URL to verify and settle this agent&apos;s payouts.
                </p>
              </details>

              <div className="field-grid compact-field-grid">
                <label className="field">
                  <span>Preferred payout rail</span>
                  <select
                    className="text-input"
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
                    className="text-input"
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
                <div className="field-grid compact-field-grid">
                  <label className="field">
                    <span>Fixed price (USD)</span>
                    <input
                      className="text-input"
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
                </div>
              ) : null}

              {(paymentProfile.pricingMode === "quote-required" || paymentProfile.pricingMode === "agent-negotiated") ? (
                <div className="field-grid compact-field-grid">
                  <label className="field">
                    <span>Quote or payment URL</span>
                    <input
                      className="text-input"
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
                </div>
              ) : null}

              <label className="field">
                <span>Notes for buyers</span>
                <textarea
                  className="text-area compact-text-area"
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
                  placeholder="Share fulfillment notes, payment expectations, or what buyers should know."
                />
              </label>
            </div>
          </div>

          <div className="action-row share-row">
            <div>
              <strong>Public agent URL</strong>
              <p className="panel-copy">
                {publicAgentUrl
                  ? publicAgentUrl
                  : "Register the agent first. Once it is registered, SantaClawz will generate the public URL here."}
              </p>
            </div>
            <div className="action-side">
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
                <a className="primary-button" href={shareOnXUrl} target="_blank" rel="noreferrer">
                  Share on X
                </a>
              ) : null}
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
