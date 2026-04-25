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
const MASTHEAD_STEPS = "1) Connect agent, 2) Deploy, 3) Share";
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
  if (agent.paidJobsEnabled) {
    return isMainnetNetworkId(agent.networkId) ? "Paid jobs enabled" : "Testnet-ready";
  }
  return "Needs payout wallet";
}

function normalizeProfileDraft(input?: Partial<AgentProfileState> | null): AgentProfileDraft {
  return {
    agentName: typeof input?.agentName === "string" ? input.agentName : "",
    representedPrincipal: typeof input?.representedPrincipal === "string" ? input.representedPrincipal : "",
    headline: typeof input?.headline === "string" ? input.headline : "",
    openClawUrl: typeof input?.openClawUrl === "string" ? input.openClawUrl : "",
    payoutAddress: typeof input?.payoutAddress === "string" ? input.payoutAddress : "",
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

    if (JSON.stringify(state.profile) === JSON.stringify(profile)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void updateAgentProfile(profile, profileSessionId)
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
  const payoutConfigured = state.payoutAddressConfigured;
  const paidJobsEnabled = state.paidJobsEnabled;
  const paidWorkStatusLabel = !published
    ? "Publish first"
    : paidJobsEnabled
      ? networkIsMainnet
        ? "Paid jobs enabled"
        : "Testnet-ready"
      : "Needs payout wallet";
  const payoutCopy = networkIsMainnet
    ? "Add the payout wallet that should receive real job proceeds. Registration can stay sponsor-first."
    : "Optional on testnet. Add this now only if you want to prep the agent for a later mainnet cutover.";
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
    ...(profile.payoutAddress?.trim().length ? [`--payout-address ${shellQuote(profile.payoutAddress)}`] : [])
  ].join(" ");
  const canSubmitHire =
    Boolean(sharedAgentId) &&
    published &&
    profile.openClawUrl.trim().length > 0 &&
    (!networkIsMainnet || paidJobsEnabled) &&
    hireDraft.taskPrompt.trim().length > 0 &&
    hireDraft.requesterContact.trim().length > 0;
  const hireStatusCopy = !published
    ? "This agent still needs to publish on Zeko before it can accept work."
    : networkIsMainnet && !paidJobsEnabled
      ? "This mainnet agent still needs a payout wallet before it can accept paid jobs."
      : `Hire requests route to ${profile.openClawUrl}.`;
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
                          agentName: profile.agentName,
                          representedPrincipal: profile.representedPrincipal,
                          headline: profile.headline,
                          openClawUrl: profile.openClawUrl,
                          ...(profile.payoutAddress?.trim().length ? { payoutAddress: profile.payoutAddress } : {}),
                          preferredProvingLocation: profile.preferredProvingLocation
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
                <h2>Share</h2>
                <p className="panel-copy">Get the public SantaClawz URL once the agent is actually registered.</p>
              </div>
            </div>
          </div>

          {networkIsMainnet ? (
            <div className="action-row action-row-form">
              <div>
                <strong>Payout wallet</strong>
                <p className="panel-copy">{payoutCopy}</p>
                <p className="panel-copy">
                  {payoutConfigured ? `Current wallet: ${profile.payoutAddress}` : "No payout wallet configured yet."}
                </p>
              </div>
              <div className="action-form-stack">
                <label className="field">
                  <span>Payout wallet address</span>
                  <input
                    className="text-input"
                    value={profile.payoutAddress ?? ""}
                    onChange={(event: ValueInputEvent) => {
                      setProfile({
                        ...profile,
                        payoutAddress: event.target.value
                      });
                    }}
                    placeholder="Enter the wallet that should receive paid-job proceeds"
                  />
                </label>
              </div>
            </div>
          ) : null}

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
                    <span className="subtle-pill">{published ? "Published" : "Registered"}</span>
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
                  <span className="subtle-pill">{agent.published ? "Published" : "Registered"}</span>
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
