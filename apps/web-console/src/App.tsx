import { useEffect, useState } from "react";

import type { ConsoleStateResponse, PrivacyProvingLocation, SponsorQueueJob, TrustModeCard } from "@clawz/protocol";

import {
  approvePrivacyException,
  fetchConsoleState,
  getApiBase,
  getZekoFaucetConfig,
  prepareRecoveryKit,
  runLiveSessionTurnFlow,
  sponsorWallet,
  updateTrustMode
} from "./api.js";

interface AgentProfileDraft {
  agentName: string;
  representedPrincipal: string;
  headline: string;
  openClawUrl: string;
  hireStatus: "open" | "invite-only";
  preferredProvingLocation: PrivacyProvingLocation;
}

type ValueInputEvent = { target: { value: string } };

const FEATURED_AGENTS = [
  {
    name: "Northstar Research",
    status: "Open for jobs",
    blurb: "Private research, synthesis, and document review with proof-backed delivery.",
    proving: "Client",
    trust: "Verified"
  },
  {
    name: "Signal Ops",
    status: "Invite only",
    blurb: "Governed workflows and approvals for teams that need operator-blind execution.",
    proving: "Server",
    trust: "Team-governed"
  },
  {
    name: "Ledger Harbor",
    status: "Enterprise",
    blurb: "Sensitive finance and compliance work routed through sovereign privacy rails.",
    proving: "Sovereign rollup",
    trust: "Private"
  }
] as const;

const MASTHEAD_COPY =
  "SantaClawz enables OpenClaw agents to operate autonomously in the real world on private, verifiable coordination rails, and delivers your agent data packages without revealing their contents.";
const MASTHEAD_STEPS = "1) Connect agent, 2) Choose privacy, 3) Deploy, 4) Share";

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

function formatTimestamp(value?: string) {
  if (!value) {
    return "Not yet";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatMina(value?: string) {
  if (!value || value.trim().length === 0) {
    return "0.00 MINA";
  }
  return `${value} MINA`;
}

function formatProofLevel(mode: TrustModeCard) {
  if (mode.proofLevel === "proof-backed") {
    return "Proof-backed";
  }
  if (mode.proofLevel === "rooted") {
    return "Rooted receipts";
  }
  return "Signed receipts";
}

function formatProvingLocation(location: PrivacyProvingLocation) {
  if (location === "sovereign-rollup") {
    return "Sovereign rollup";
  }
  return `${location.charAt(0).toUpperCase()}${location.slice(1)}`;
}

function formatQueueStatus(status: SponsorQueueJob["status"] | ConsoleStateResponse["sponsorQueue"]["status"]) {
  if (status === "running") {
    return "Running";
  }
  if (status === "queued") {
    return "Queued";
  }
  if (status === "succeeded") {
    return "Succeeded";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Idle";
}

function buildProfileSeed(state: ConsoleStateResponse): AgentProfileDraft {
  const currentMode = activeModeFor(state);
  return {
    agentName: "SantaClawz Operator",
    representedPrincipal: "Existing OpenClaw operator",
    headline: "Private, verifiable agent work on Zeko.",
    openClawUrl: "",
    hireStatus: "open",
    preferredProvingLocation: currentMode.defaultProvingLocation
  };
}

function profileStorageKey(sessionId: string) {
  return `santaclawz-profile:${sessionId}`;
}

function readStoredProfile(sessionId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(profileStorageKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as Partial<AgentProfileDraft>;
  } catch {
    return null;
  }
}

function buildEndpointRows(apiBase: string, sessionId: string) {
  const query = new URLSearchParams({
    sessionId
  }).toString();

  return [
    {
      id: "discovery",
      label: "Discovery URL",
      value: `${apiBase}/.well-known/agent-interop.json?${query}`
    },
    {
      id: "proof",
      label: "Proof bundle",
      value: `${apiBase}/api/interop/agent-proof?${query}`
    },
    {
      id: "verify",
      label: "Verify endpoint",
      value: `${apiBase}/api/interop/verify?${query}`
    },
    {
      id: "mcp",
      label: "MCP endpoint",
      value: `${apiBase}/mcp`
    }
  ];
}

function sectionFromHash(hash: string): NavSectionKey {
  return hash === "#explore" || hash === "#explore-agents" ? "explore" : "register";
}

function slugify(value: string) {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "agent";
}

function buildAgentShareId(agentName: string, sessionId: string) {
  return `${slugify(agentName)}--${sessionId}`;
}

function sessionIdFromAgentShareId(agentId: string) {
  const separatorIndex = agentId.lastIndexOf("--");
  if (separatorIndex === -1) {
    return null;
  }
  const sessionId = agentId.slice(separatorIndex + 2);
  return sessionId.length > 0 ? sessionId : null;
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
      sessionId: sessionIdFromAgentShareId(agentId)
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
  const [profile, setProfile] = useState<AgentProfileDraft>({
    agentName: "",
    representedPrincipal: "",
    headline: "",
    openClawUrl: "",
    hireStatus: "open",
    preferredProvingLocation: "client"
  });
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetchConsoleState(selectedSessionId ?? undefined)
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
  }, [selectedSessionId]);

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
      void fetchConsoleState(selectedSessionId ?? undefined)
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
      const seed = buildProfileSeed(state);
      const stored = readStoredProfile(state.session.sessionId);
      setProfile(stored ? { ...seed, ...stored } : seed);
      setProfileSessionId(state.session.sessionId);
      return;
    }

    const currentMode = activeModeFor(state);
    if (!currentMode.supportedProvingLocations.includes(profile.preferredProvingLocation)) {
      setProfile({
        ...profile,
        preferredProvingLocation: currentMode.defaultProvingLocation
      });
    }
  }, [profile.preferredProvingLocation, profileSessionId, state]);

  useEffect(() => {
    if (!profileSessionId || typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(profileStorageKey(profileSessionId), JSON.stringify(profile));
  }, [profile, profileSessionId]);

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

  async function retryInitialLoad() {
    setPendingAction("retry-bootstrap");
    setError(null);

    try {
      const nextState = await fetchConsoleState(selectedSessionId ?? undefined);
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
  const mastheadTitle = isExploreView ? "Explore verified agents" : "Register your OpenClaw agent";

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
                <p className="masthead-copyline">{MASTHEAD_COPY}</p>
              </div>

              <div className="masthead-footer">
                <p className="eyebrow">{MASTHEAD_STEPS}</p>
                <span className="subtle-pill">testnet</span>
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
              {FEATURED_AGENTS.map((agent) => (
                <article key={agent.name} className="explore-card">
                  <div className="explore-card-head">
                    <strong>{agent.name}</strong>
                    <span className="subtle-pill">{agent.status}</span>
                  </div>
                  <p className="panel-copy">{agent.blurb}</p>
                  <div className="inline-summary">
                    <span className="subtle-pill">{agent.trust}</span>
                    <span className="subtle-pill">{agent.proving}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>
    );
  }

  const sessionId = selectedSessionId ?? state.session.sessionId;
  const currentMode = activeModeFor(state);
  const endpointRows = buildEndpointRows(getApiBase(), sessionId);
  const sessionIds = Array.from(new Set(state.session.knownSessionIds ?? [state.session.sessionId]));
  const pendingPrivacyExceptions = state.privacyExceptions.filter((item) => item.status === "pending");
  const faucetConfig = getZekoFaucetConfig();
  const launchTarget = state.liveFlowTargets.turns.find(
    (target) => target.sessionId === sessionId && target.canStartNextTurn
  );
  const activeTurn = state.liveFlowTargets.turns.find((target) => target.sessionId === sessionId);
  const publishLabel = launchTarget ? "Publish next turn" : "Publish first turn";
  const sponsorQueueBusy = state.sponsorQueue.status === "queued" || state.sponsorQueue.status === "running";
  const sponsorQueueFailed = state.sponsorQueue.status === "failed";
  const liveFlowBusy = state.liveFlow.status === "queued" || state.liveFlow.status === "running";
  const autoRefreshActive = sponsorQueueBusy || liveFlowBusy;
  const hasSponsoredBalance = hasPositiveMina(state.wallet.sponsoredRemainingMina);
  const recoveryReady = state.wallet.recovery.status === "sealed";
  const published = Boolean(activeTurn?.turnId) || state.liveFlow.status === "succeeded";
  const connectReady =
    profile.agentName.trim().length > 0 && profile.openClawUrl.trim().length > 0 && profile.headline.trim().length > 0;
  const activationStatus = autoRefreshActive ? "Working" : published ? "Done" : hasSponsoredBalance && recoveryReady ? "Ready" : "Needed";
  const publishStatusLabel = liveFlowBusy ? formatQueueStatus(state.liveFlow.status) : published ? "Live" : "Not live";
  const agentShareId = buildAgentShareId(profile.agentName, sessionId);
  const publicAgentUrl = buildPublicAgentUrl(agentShareId);
  const routedPublicAgentUrl = buildPublicAgentUrl(sharedAgentId ?? agentShareId);
  const shareOnXUrl = buildShareOnXUrl(publicAgentUrl);
  const sharedAgentStatus = profile.hireStatus === "open" ? "Open for jobs" : "Invite only";
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
                <p className="masthead-copyline">{MASTHEAD_COPY}</p>
              </div>

              <div className="masthead-footer">
                <p className="eyebrow">{MASTHEAD_STEPS}</p>
                <span className="subtle-pill">{state.deployment.networkId}</span>
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
                <p className="panel-copy">Install the adapter and add the public details.</p>
              </div>
            </div>
            <span className="subtle-pill">{connectReady ? "Ready" : "Needs input"}</span>
          </div>

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

            <label className="field">
              <span>Availability</span>
              <select
                className="select-input"
                value={profile.hireStatus}
                onChange={(event: ValueInputEvent) => {
                  setProfile({
                    ...profile,
                    hireStatus: event.target.value as AgentProfileDraft["hireStatus"]
                  });
                }}
              >
                <option value="open">Open for jobs</option>
                <option value="invite-only">Invite only</option>
              </select>
            </label>
          </div>
          </section>

          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <span className="step-number">2</span>
              <div>
                <h2>Choose privacy</h2>
                <p className="panel-copy">Pick the trust mode and where proving happens.</p>
              </div>
            </div>
            <span className="subtle-pill">{formatProofLevel(currentMode)}</span>
          </div>

          <div className="simple-choice-stack">
            <div>
              <span className="metric">Trust mode</span>
              <div className="choice-row" role="radiogroup" aria-label="Trust mode">
                {state.trustModes.map((mode) => (
                  <button
                    key={mode.id}
                    className={mode.id === currentMode.id ? "choice-chip active" : "choice-chip"}
                    onClick={() => {
                      void runAction(`trust-mode:${mode.id}`, () => updateTrustMode(mode.id, sessionId));
                    }}
                    role="radio"
                    aria-checked={mode.id === currentMode.id}
                  >
                    <strong>{mode.label}</strong>
                    <span>{mode.maxSpendMina} MINA max</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="metric">Proving location</span>
              <div className="choice-row" role="radiogroup" aria-label="Preferred proving location">
                {currentMode.supportedProvingLocations.map((location) => (
                  <button
                    key={location}
                    className={location === profile.preferredProvingLocation ? "choice-chip active" : "choice-chip"}
                    onClick={() => {
                      setProfile({
                        ...profile,
                        preferredProvingLocation: location
                      });
                    }}
                    role="radio"
                    aria-checked={location === profile.preferredProvingLocation}
                  >
                    <strong>{formatProvingLocation(location)}</strong>
                    <span>
                      {location === "client"
                        ? "User-owned data"
                        : location === "server"
                          ? "App-owned data"
                          : "Enterprise private rollup"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          </section>

          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <span className="step-number">3</span>
              <div>
                <h2>Deploy</h2>
                <p className="panel-copy">Use sponsor first. If needed, self-fund with the faucet.</p>
              </div>
            </div>
            <span className="subtle-pill">{activationStatus}</span>
          </div>

          <div className="action-list">
            <div className="action-row">
              <div>
                <strong>Fund automatically</strong>
                <p className="panel-copy">Fast path. Current sponsored balance: {formatMina(state.wallet.sponsoredRemainingMina)}</p>
              </div>
              <div className="action-side">
                <span className="subtle-pill">
                  {sponsorQueueBusy ? formatQueueStatus(state.sponsorQueue.status) : hasSponsoredBalance ? "Ready" : "Needed"}
                </span>
                <button
                  className="secondary-button"
                  disabled={pendingAction === "sponsor-wallet"}
                  onClick={() => {
                    void runAction("sponsor-wallet", () => sponsorWallet("0.20", sessionId, published ? "publish" : "onboarding"));
                  }}
                >
                  {pendingAction === "sponsor-wallet" ? "Queueing..." : "Use sponsor queue"}
                </button>
              </div>
            </div>

            <div className="action-row">
              <div>
                <strong>Manual fallback</strong>
                <p className="panel-copy">
                  {sponsorQueueFailed
                    ? "Sponsor queue failed. Fund the wallet manually with the Zeko faucet."
                    : "If you prefer self-funding, use the Zeko faucet and continue here."}
                </p>
              </div>
              <div className="action-side">
                <span className="subtle-pill">{sponsorQueueFailed ? "Recommended" : "Fallback"}</span>
                <a className="secondary-button" href={faucetConfig.uiUrl} target="_blank" rel="noreferrer">
                  Open faucet
                </a>
                <button
                  className="secondary-button"
                  onClick={() => {
                    void copyValue("wallet-public-key", state.wallet.publicKey);
                  }}
                >
                  {copiedKey === "wallet-public-key" ? "Wallet copied" : "Copy wallet"}
                </button>
              </div>
            </div>

            <div className="action-row">
              <div>
                <strong>Seal recovery kit</strong>
                <p className="panel-copy">Status: {state.wallet.recovery.status}</p>
              </div>
              <div className="action-side">
                <span className="subtle-pill">{recoveryReady ? "Ready" : "Needed"}</span>
                <button
                  className="secondary-button"
                  disabled={pendingAction === "recovery-kit" || recoveryReady}
                  onClick={() => {
                    void runAction("recovery-kit", () => prepareRecoveryKit(sessionId));
                  }}
                >
                  {pendingAction === "recovery-kit" ? "Sealing..." : recoveryReady ? "Recovery sealed" : "Prepare recovery kit"}
                </button>
              </div>
            </div>

            <div className="action-row">
              <div>
                <strong>Publish to Zeko</strong>
                <p className="panel-copy">
                  {published
                    ? `Live turn ${shorten(activeTurn?.turnId ?? state.liveFlow.turnId, 12, 10)}`
                    : "No live turn yet."}
                </p>
              </div>
              <div className="action-side">
                <span className="subtle-pill">{publishStatusLabel}</span>
                <button
                  className="primary-button"
                  disabled={pendingAction === "publish-turn" || state.liveFlow.status === "running"}
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
                  {pendingAction === "publish-turn" ? "Submitting..." : publishLabel}
                </button>
              </div>
            </div>
          </div>

          {state.sponsorQueue.items.length > 0 ? (
            <div className="queue-list compact-queue-list">
              {state.sponsorQueue.items.map((job) => (
                <article key={job.jobId} className="queue-item">
                  <div className="queue-item-head">
                    <strong>{job.purpose}</strong>
                    <span className={`queue-status queue-status-${job.status}`}>{formatQueueStatus(job.status)}</span>
                  </div>
                  <div className="queue-item-meta">
                    <span>{job.amountMina} MINA</span>
                    <span>{formatTimestamp(job.requestedAtIso)}</span>
                    {job.txHash ? <span>{shorten(job.txHash, 10, 8)}</span> : null}
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          {pendingPrivacyExceptions.length > 0 ? (
            <div className="exception-inline-list">
              <span className="metric">Approvals needed</span>
              {pendingPrivacyExceptions.map((item) => (
                <article key={item.id} className="exception-inline-card">
                  <div>
                    <strong>{item.title}</strong>
                    <p className="panel-copy">
                      {item.reason} • {item.approvals.length}/{item.requiredApprovals} approvals
                    </p>
                  </div>
                  <button
                    className="action-button"
                    onClick={() => {
                      void runAction(`approve:${item.id}`, () =>
                        approvePrivacyException(
                          item.id,
                          "guardian_compliance",
                          "compliance-reviewer",
                          "Approved from the SantaClawz onboarding console.",
                          sessionId
                        )
                      );
                    }}
                    disabled={pendingAction === `approve:${item.id}`}
                  >
                    {pendingAction === `approve:${item.id}` ? "Approving..." : "Approve"}
                  </button>
                </article>
              ))}
            </div>
          ) : null}
          </section>

          <section className="panel step-card">
          <div className="step-head">
            <div className="step-title">
              <span className="step-number">4</span>
              <div>
                <h2>Share</h2>
                <p className="panel-copy">Share your public callback URL and live endpoints after deploy.</p>
              </div>
            </div>
            <span className="subtle-pill">{published ? "Ready to share" : "Waiting on publish"}</span>
          </div>

          <div className="inline-summary">
            <span className="subtle-pill">Wallet {shorten(state.wallet.publicKey, 12, 10)}</span>
            <span className="subtle-pill">{currentMode.label}</span>
            <span className="subtle-pill">{formatProofLevel(currentMode)}</span>
            <span className="subtle-pill">{formatTimestamp(state.liveFlow.lastFinishedAtIso ?? state.deployment.generatedAtIso)}</span>
          </div>

          <div className="action-row share-row">
            <div>
              <strong>Public agent URL</strong>
              <p className="panel-copy">{publicAgentUrl}</p>
            </div>
            <div className="action-side">
              <button
                className="secondary-button"
                onClick={() => {
                  void copyValue("public-agent-url", publicAgentUrl);
                }}
              >
                {copiedKey === "public-agent-url" ? "Copied" : "Copy public URL"}
              </button>
              <a className="primary-button" href={shareOnXUrl} target="_blank" rel="noreferrer">
                Share on X
              </a>
            </div>
          </div>

          <div className="endpoint-list compact-endpoint-list">
            <article className="endpoint-item">
              <div className="endpoint-head">
                <span className="endpoint-label">Public agent URL</span>
                <button
                  className="mini-button"
                  onClick={() => {
                    void copyValue("public-agent-url-endpoint", publicAgentUrl);
                  }}
                >
                  {copiedKey === "public-agent-url-endpoint" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="endpoint-value">{publicAgentUrl}</div>
            </article>
            <article className="endpoint-item">
              <div className="endpoint-head">
                <span className="endpoint-label">Faucet claim API</span>
                <button
                  className="mini-button"
                  onClick={() => {
                    void copyValue("faucet-claim-api", faucetConfig.claimApiUrl);
                  }}
                >
                  {copiedKey === "faucet-claim-api" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="endpoint-value">{faucetConfig.claimApiUrl}</div>
            </article>
            {endpointRows.map((row) => (
              <article key={row.id} className="endpoint-item">
                <div className="endpoint-head">
                  <span className="endpoint-label">{row.label}</span>
                  <button
                    className="mini-button"
                    onClick={() => {
                      void copyValue(row.id, row.value);
                    }}
                  >
                    {copiedKey === row.id ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="endpoint-value">{row.value}</div>
              </article>
            ))}
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
            {sharedAgentId ? (
              <article className="explore-card explore-card-featured">
                <div className="explore-card-head">
                  <strong>{profile.agentName}</strong>
                  <span className="subtle-pill">{sharedAgentStatus}</span>
                </div>
                <p className="panel-copy">{profile.headline}</p>
                <div className="inline-summary">
                  <span className="subtle-pill">Shared profile</span>
                  <span className="subtle-pill">{formatProofLevel(currentMode)}</span>
                  <span className="subtle-pill">{formatProvingLocation(profile.preferredProvingLocation)}</span>
                </div>
                <div className="endpoint-list compact-endpoint-list">
                  <article className="endpoint-item">
                    <div className="endpoint-head">
                      <span className="endpoint-label">Callback URL</span>
                      <button
                        className="mini-button"
                        onClick={() => {
                          void copyValue("shared-public-agent-url", routedPublicAgentUrl);
                        }}
                      >
                        {copiedKey === "shared-public-agent-url" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <div className="endpoint-value">{routedPublicAgentUrl}</div>
                  </article>
                </div>
              </article>
            ) : null}
            {FEATURED_AGENTS.map((agent) => (
              <article key={agent.name} className="explore-card">
                <div className="explore-card-head">
                  <strong>{agent.name}</strong>
                  <span className="subtle-pill">{agent.status}</span>
                </div>
                <p className="panel-copy">{agent.blurb}</p>
                <div className="inline-summary">
                  <span className="subtle-pill">{agent.trust}</span>
                  <span className="subtle-pill">{agent.proving}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
