const DEFAULT_API_BASE = process.env.CLAWZ_API_BASE?.trim() || "https://api.santaclawz.ai";
const DEFAULT_SITE_BASE = process.env.CLAWZ_SITE_BASE?.trim() || "https://santaclawz.ai";
const VALID_TRUST_MODES = new Set(["fast", "private", "verified", "team-governed"]);
const VALID_PROVING_LOCATIONS = new Set(["client", "sovereign-rollup"]);

function printUsage() {
  console.error(`Usage:
  pnpm register:agent -- \\
    --agent-name "Northstar Research" \\
    --headline "Private research and verifiable delivery." \\
    --openclaw-url "https://agent.example.com" \\
    [--represented-principal "Northstar Labs"] \\
    [--payout-address "B62..."] \\
    [--trust-mode private] \\
    [--proving-location client] \\
    [--api-base https://api.santaclawz.ai] \\
    [--site-base https://santaclawz.ai] \\
    [--json]
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    if (key === "json" || key === "help") {
      args[key] = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }
  return args;
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const agentName = typeof args["agent-name"] === "string" ? args["agent-name"].trim() : "";
const headline = typeof args.headline === "string" ? args.headline.trim() : "";
const openClawUrl = typeof args["openclaw-url"] === "string" ? args["openclaw-url"].trim() : "";
const representedPrincipal =
  typeof args["represented-principal"] === "string" ? args["represented-principal"].trim() : undefined;
const payoutAddress = typeof args["payout-address"] === "string" ? args["payout-address"].trim() : undefined;
const trustModeId = typeof args["trust-mode"] === "string" ? args["trust-mode"].trim() : "private";
const preferredProvingLocation =
  typeof args["proving-location"] === "string" ? args["proving-location"].trim() : undefined;
const apiBase = normalizeBaseUrl(typeof args["api-base"] === "string" ? args["api-base"].trim() : DEFAULT_API_BASE);
const siteBase = normalizeBaseUrl(typeof args["site-base"] === "string" ? args["site-base"].trim() : DEFAULT_SITE_BASE);

if (!agentName || !headline || !openClawUrl) {
  printUsage();
  throw new Error("agent-name, headline, and openclaw-url are required.");
}

if (!VALID_TRUST_MODES.has(trustModeId)) {
  throw new Error(`Unsupported trust mode: ${trustModeId}`);
}

if (preferredProvingLocation && !VALID_PROVING_LOCATIONS.has(preferredProvingLocation)) {
  throw new Error(`Unsupported proving location: ${preferredProvingLocation}`);
}

const response = await fetch(`${apiBase}/api/console/register`, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({
    agentName,
    headline,
    openClawUrl,
    ...(payoutAddress ? { payoutAddress } : {}),
    ...(representedPrincipal ? { representedPrincipal } : {}),
    trustModeId,
    ...(preferredProvingLocation ? { preferredProvingLocation } : {})
  })
});

if (!response.ok) {
  const errorPayload = await response.json().catch(() => null);
  throw new Error(errorPayload?.error ?? `Registration failed with status ${response.status}`);
}

const state = await response.json();
const sessionId = state.session?.sessionId;
const agentId = state.agentId;

if (typeof sessionId !== "string" || typeof agentId !== "string") {
  throw new Error("Registration succeeded but response was missing sessionId or agentId.");
}

const result = {
  apiBase,
  siteBase,
  agentId,
  sessionId,
  networkId: state.deployment?.networkId,
  trustModeId: state.wallet?.trustModeId,
  provingLocation: state.profile?.preferredProvingLocation,
  payoutAddressConfigured: state.payoutAddressConfigured,
  paidJobsEnabled: state.paidJobsEnabled,
  publicAgentUrl: `${siteBase}/explore/${encodeURIComponent(agentId)}`,
  discoveryUrl: `${apiBase}/.well-known/agent-interop.json?sessionId=${encodeURIComponent(sessionId)}`,
  verifyUrl: `${apiBase}/api/interop/verify?sessionId=${encodeURIComponent(sessionId)}`,
  profile: state.profile
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Registered ${agentName}`);
  console.log(`Agent ID: ${result.agentId}`);
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Network: ${result.networkId}`);
  console.log(`Public URL: ${result.publicAgentUrl}`);
  console.log(`Discovery URL: ${result.discoveryUrl}`);
  console.log(`Verify URL: ${result.verifyUrl}`);
  console.log(`Payout configured: ${result.payoutAddressConfigured ? "yes" : "no"}`);
  console.log(`Paid jobs enabled: ${result.paidJobsEnabled ? "yes" : "no"}`);
}
