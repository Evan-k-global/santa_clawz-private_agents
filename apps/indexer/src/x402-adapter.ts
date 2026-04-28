import type {
  AgentPaymentRail,
  AgentPricingMode,
  AgentX402Plan,
  AgentX402RailPlan,
  ConsoleStateResponse
} from "@clawz/protocol";
import {
  buildBaseMainnetUsdcRail,
  buildCatalog,
  buildEthereumMainnetUsdcRail,
  buildPaymentRequired,
  buildSettlementResponse,
  assertPaymentPayload,
  CDPFacilitatorClient,
  decodeBase64Json,
  encodeBase64Json,
  HostedX402FacilitatorClient,
  InMemorySettlementLedger,
  verifyPayment,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER
} from "zeko-x402";

export const X402_CATALOG_ROUTE = "/.well-known/x402.json";
export const X402_RESOURCE_ROUTE = "/api/x402/proof";
export const X402_VERIFY_ROUTE = "/api/x402/verify";
export const X402_SETTLE_ROUTE = "/api/x402/settle";

const BASE_MAINNET = {
  networkId: "eip155:8453",
  assetSymbol: "USDC",
  assetDecimals: 6,
  assetStandard: "erc20" as const,
  assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

const ETHEREUM_MAINNET = {
  networkId: "eip155:1",
  assetSymbol: "USDC",
  assetDecimals: 6,
  assetStandard: "erc20" as const,
  assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
};

type JsonRecord = Record<string, unknown>;

interface AgentX402RuntimeContext {
  plan: AgentX402Plan;
  serviceNetworkId: string;
  paymentContext: JsonRecord;
  paymentRequired: JsonRecord;
  catalog: JsonRecord;
  runtimeRails: AgentX402RailPlan[];
}

interface AgentX402VerificationResult {
  ok: boolean;
  paymentRequired: JsonRecord;
  paymentPayload: JsonRecord;
  rail: AgentX402RailPlan;
  localVerification: JsonRecord;
  remoteVerification?: JsonRecord;
  headers: Record<string, string>;
  error?: string;
}

interface AgentX402SettlementResult extends AgentX402VerificationResult {
  remoteSettlement: JsonRecord;
  paymentResponse: JsonRecord;
}

const settlementLedgers = new Map<string, any>();

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toQueryString(sessionId: string): string {
  return new URLSearchParams({ sessionId }).toString();
}

function defaultZekoAssetSymbol(networkId: string): string {
  return networkId.toLowerCase().endsWith(":testnet") ? "tMINA" : "MINA";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuotedPricing(mode: AgentPricingMode): boolean {
  return mode === "quote-required" || mode === "agent-negotiated";
}

function executionMode(trigger: ConsoleStateResponse["profile"]["paymentProfile"]["settlementTrigger"]): AgentX402RailPlan["executionMode"] {
  return trigger === "on-proof" ? "reserve-release" : "settle-first";
}

function serviceIdFor(agentId: string): string {
  const base = process.env.CLAWZ_X402_SERVICE_ID?.trim();
  return base && base.length > 0 ? `${base}:${agentId}` : `santaclawz-agent:${agentId}`;
}

function pushPricingReadiness(
  profile: ConsoleStateResponse["profile"],
  missing: string[],
  notes: string[]
): Pick<AgentX402RailPlan, "amountUsd" | "maxAmountUsd"> {
  if (profile.paymentProfile.pricingMode === "fixed-exact") {
    if (!profile.paymentProfile.fixedAmountUsd?.trim()) {
      missing.push("Set a fixed USD amount.");
      return {};
    }
    return { amountUsd: profile.paymentProfile.fixedAmountUsd };
  }

  if (profile.paymentProfile.pricingMode === "capped-exact") {
    if (!profile.paymentProfile.maxAmountUsd?.trim()) {
      missing.push("Set a max USD amount.");
      return {};
    }
    notes.push("Capped exact pricing still needs SantaClawz release policy before live settlement.");
    return { maxAmountUsd: profile.paymentProfile.maxAmountUsd };
  }

  if (isQuotedPricing(profile.paymentProfile.pricingMode)) {
    if (!profile.paymentProfile.quoteUrl?.trim()) {
      missing.push("Provide a quote URL for negotiated pricing.");
    } else {
      notes.push("Quoted or agent-negotiated pricing needs a quote step before emitting an exact x402 challenge.");
    }
    return {};
  }

  return {};
}

function buildBaseRailPlan(consoleState: ConsoleStateResponse): AgentX402RailPlan {
  const profile = consoleState.profile;
  const missing: string[] = [];
  const notes: string[] = [];
  const payTo = profile.payoutWallets.base?.trim();
  const settlementTrigger = profile.paymentProfile.settlementTrigger;
  const settleOnProof = settlementTrigger === "on-proof";
  const operatorFacilitatorUrl = profile.paymentProfile.baseFacilitatorUrl?.trim();
  const facilitatorUrl =
    operatorFacilitatorUrl || process.env.CLAWZ_X402_BASE_FACILITATOR_URL?.trim();
  const escrowContract = process.env.CLAWZ_X402_BASE_ESCROW_CONTRACT?.trim();

  if (!payTo) {
    missing.push("Add a Base payout wallet.");
  }

  const pricing = pushPricingReadiness(profile, missing, notes);

  if (!operatorFacilitatorUrl) {
    missing.push("Add a Base facilitator URL for this agent.");
  }

  if (settleOnProof && !escrowContract) {
    missing.push("Set CLAWZ_X402_BASE_ESCROW_CONTRACT for Base reserve-release.");
  }

  if (operatorFacilitatorUrl && !settleOnProof) {
    notes.push("Base exact-price flows use the operator-hosted x402 facilitator for this agent.");
  }

  if (facilitatorUrl && settleOnProof) {
    notes.push("Base reserve-release is expected to use a self-hosted or dedicated facilitator path.");
  }
  if (!operatorFacilitatorUrl && facilitatorUrl) {
    notes.push("A platform-level fallback facilitator is configured, but this agent still needs its own facilitator URL for payouts-live status.");
  }

  return {
    rail: "base-usdc",
    settlementRail: "evm",
    networkId: BASE_MAINNET.networkId,
    assetSymbol: BASE_MAINNET.assetSymbol,
    assetDecimals: BASE_MAINNET.assetDecimals,
    assetStandard: BASE_MAINNET.assetStandard,
    assetAddress: BASE_MAINNET.assetAddress,
    builderHint: settleOnProof ? "buildBaseMainnetUsdcReserveReleaseRail" : "buildBaseMainnetUsdcRail",
    facilitatorMode: settleOnProof ? "evm-reserve-release" : "x402-http",
    settlementModel: settleOnProof ? "x402-base-usdc-reserve-release-v2" : "x402-exact-evm-v1",
    executionMode: executionMode(settlementTrigger),
    ...(payTo ? { payTo } : {}),
    ...(escrowContract ? { settlementContractAddress: escrowContract } : {}),
    ...(facilitatorUrl ? { facilitatorUrl } : {}),
    ...pricing,
    ready: consoleState.paymentsEnabled && missing.length === 0 && !isQuotedPricing(profile.paymentProfile.pricingMode),
    missing,
    notes
  };
}

function buildEthereumRailPlan(consoleState: ConsoleStateResponse): AgentX402RailPlan {
  const profile = consoleState.profile;
  const missing: string[] = [];
  const notes: string[] = [];
  const payTo = profile.payoutWallets.ethereum?.trim();
  const settlementTrigger = profile.paymentProfile.settlementTrigger;
  const operatorFacilitatorUrl = profile.paymentProfile.ethereumFacilitatorUrl?.trim();
  const facilitatorUrl =
    operatorFacilitatorUrl || process.env.CLAWZ_X402_ETHEREUM_FACILITATOR_URL?.trim();

  if (!payTo) {
    missing.push("Add an Ethereum payout wallet.");
  }

  const pricing = pushPricingReadiness(profile, missing, notes);

  if (!operatorFacilitatorUrl) {
    missing.push("Add an Ethereum facilitator URL for this agent.");
  }

  if (settlementTrigger === "on-proof") {
    missing.push("Reserve-release is currently Base-first in zeko-x402; Ethereum stays a compatibility rail for now.");
  }

  if (operatorFacilitatorUrl) {
    notes.push("Ethereum mainnet uses the operator-hosted facilitator for this rail.");
  }
  if (!operatorFacilitatorUrl && facilitatorUrl) {
    notes.push("A platform-level fallback facilitator is configured, but this agent still needs its own facilitator URL for payouts-live status.");
  }

  return {
    rail: "ethereum-usdc",
    settlementRail: "evm",
    networkId: ETHEREUM_MAINNET.networkId,
    assetSymbol: ETHEREUM_MAINNET.assetSymbol,
    assetDecimals: ETHEREUM_MAINNET.assetDecimals,
    assetStandard: ETHEREUM_MAINNET.assetStandard,
    assetAddress: ETHEREUM_MAINNET.assetAddress,
    builderHint: "buildEthereumMainnetUsdcRail",
    facilitatorMode: "x402-http",
    settlementModel: "x402-exact-evm-v1",
    executionMode: executionMode(settlementTrigger),
    ...(payTo ? { payTo } : {}),
    ...(facilitatorUrl ? { facilitatorUrl } : {}),
    ...pricing,
    ready: consoleState.paymentsEnabled && missing.length === 0 && !isQuotedPricing(profile.paymentProfile.pricingMode),
    missing,
    notes
  };
}

function buildZekoRailPlan(consoleState: ConsoleStateResponse): AgentX402RailPlan {
  const profile = consoleState.profile;
  const deployment = consoleState.deployment;
  const missing: string[] = [];
  const notes: string[] = [];
  const beneficiaryAddress = profile.payoutWallets.zeko?.trim();
  const settlementContractAddress = process.env.CLAWZ_X402_ZEKO_SETTLEMENT_CONTRACT?.trim();

  if (!beneficiaryAddress) {
    missing.push("Add a Zeko payout wallet to use as the settlement beneficiary.");
  }
  if (!settlementContractAddress) {
    missing.push("Set CLAWZ_X402_ZEKO_SETTLEMENT_CONTRACT for the Zeko settlement rail.");
  }

  const pricing = pushPricingReadiness(profile, missing, notes);
  notes.push("The Zeko rail should use buildZekoSettlementContractRail plus a witness-backed settlement update.");

  return {
    rail: "zeko-native",
    settlementRail: "zeko",
    networkId: deployment.networkId,
    assetSymbol: defaultZekoAssetSymbol(deployment.networkId),
    assetDecimals: 9,
    assetStandard: "native",
    builderHint: "buildZekoSettlementContractRail",
    facilitatorMode: "zeko-settlement-contract",
    settlementModel: "x402-exact-settlement-zkapp-v1",
    executionMode: executionMode(profile.paymentProfile.settlementTrigger),
    ...(settlementContractAddress ? { payTo: settlementContractAddress, settlementContractAddress } : {}),
    ...(beneficiaryAddress ? { beneficiaryAddress } : {}),
    ...pricing,
    ready: consoleState.paymentsEnabled && missing.length === 0 && !isQuotedPricing(profile.paymentProfile.pricingMode),
    missing,
    notes
  };
}

export function buildAgentX402Plan(input: {
  baseUrl: string;
  consoleState: ConsoleStateResponse;
}): AgentX402Plan {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const consoleState = input.consoleState;
  const sessionId = consoleState.session.sessionId;
  const agentId = consoleState.agentId;
  const profile = consoleState.profile;
  const query = toQueryString(sessionId);
  const rails = profile.paymentProfile.supportedRails.map((rail) => {
    if (rail === "base-usdc") {
      return buildBaseRailPlan(consoleState);
    }
    if (rail === "ethereum-usdc") {
      return buildEthereumRailPlan(consoleState);
    }
    return buildZekoRailPlan(consoleState);
  });
  const published = consoleState.liveFlowTargets.turns.some((target) => target.sessionId === sessionId);

  return {
    serviceId: serviceIdFor(agentId),
    agentId,
    sessionId,
    published,
    paymentsEnabled: consoleState.paymentsEnabled,
    paymentProfileReady: consoleState.paymentProfileReady,
    payoutAddressConfigured: consoleState.payoutAddressConfigured,
    pricingMode: profile.paymentProfile.pricingMode,
    settlementTrigger: profile.paymentProfile.settlementTrigger,
    ...(profile.paymentProfile.defaultRail ? { defaultRail: profile.paymentProfile.defaultRail } : {}),
    ...(profile.paymentProfile.quoteUrl ? { quoteUrl: profile.paymentProfile.quoteUrl } : {}),
    ...(profile.paymentProfile.paymentNotes ? { paymentNotes: profile.paymentProfile.paymentNotes } : {}),
    proofBundleUrl: `${baseUrl}/api/interop/agent-proof?${query}`,
    verifyProofUrl: `${baseUrl}/api/interop/verify?${query}`,
    catalogPreviewUrl: `${baseUrl}${X402_CATALOG_ROUTE}?${query}`,
    resourcePreviewUrl: `${baseUrl}${X402_RESOURCE_ROUTE}?${query}`,
    verifyPaymentUrl: `${baseUrl}${X402_VERIFY_ROUTE}?${query}`,
    settlePaymentUrl: `${baseUrl}${X402_SETTLE_ROUTE}?${query}`,
    rails
  };
}

function railDescription(rail: AgentX402RailPlan): string {
  if (rail.rail === "base-usdc") {
    return rail.executionMode === "reserve-release"
      ? "Base mainnet USDC rail using reserve-now, release-on-proof settlement."
      : "Base mainnet USDC rail using exact-price x402 settlement.";
  }

  if (rail.rail === "ethereum-usdc") {
    return "Ethereum mainnet USDC rail using exact-price x402 settlement.";
  }

  return "Zeko settlement-contract rail using a proof-aware zkApp settlement path.";
}

function railAcceptPreview(plan: AgentX402Plan, rail: AgentX402RailPlan) {
  const amount = rail.amountUsd ?? rail.maxAmountUsd;
  if (!amount) {
    return undefined;
  }

  return {
    scheme: "exact",
    settlementRail: rail.settlementRail,
    network: rail.networkId,
    asset: {
      symbol: rail.assetSymbol,
      decimals: rail.assetDecimals,
      standard: rail.assetStandard,
      ...(rail.assetAddress ? { address: rail.assetAddress } : {})
    },
    price: amount,
    amount,
    ...(rail.payTo ? { payTo: rail.payTo } : {}),
    settlementModel: rail.settlementModel,
    description: railDescription(rail),
    mimeType: "application/json",
    outputSchema: {
      type: "clawz-agent-proof-bundle",
      proofBundleUrl: plan.proofBundleUrl,
      verifyUrl: plan.verifyProofUrl
    },
    extensions: {
      santaclawz: {
        previewOnly: true,
        ready: rail.ready,
        builderHint: rail.builderHint,
        executionMode: rail.executionMode,
        pricingMode: plan.pricingMode,
        settlementTrigger: plan.settlementTrigger,
        missing: rail.missing,
        notes: rail.notes
      },
      ...(rail.settlementRail === "evm"
        ? {
            evm: {
              ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {}),
              ...(rail.settlementContractAddress ? { escrowContract: rail.settlementContractAddress } : {})
            }
          }
        : {
            zeko: {
              ...(rail.settlementContractAddress ? { contractAddress: rail.settlementContractAddress } : {}),
              ...(rail.beneficiaryAddress ? { beneficiaryAddress: rail.beneficiaryAddress } : {})
            }
          })
    }
  };
}

function incompleteRailPreview(rail: AgentX402RailPlan) {
  return {
    rail: rail.rail,
    ready: rail.ready,
    builderHint: rail.builderHint,
    executionMode: rail.executionMode,
    settlementModel: rail.settlementModel,
    missing: rail.missing,
    notes: rail.notes
  };
}

export function buildAgentX402CatalogPreview(input: {
  serviceNetworkId: string;
  plan: AgentX402Plan;
}) {
  const accepts = input.plan.rails
    .filter((rail) => rail.ready)
    .map((rail) => railAcceptPreview(input.plan, rail))
    .filter((rail): rail is NonNullable<ReturnType<typeof railAcceptPreview>> => Boolean(rail));

  return {
    protocol: "x402",
    version: "2",
    previewOnly: true,
    serviceId: input.plan.serviceId,
    resource: {
      chain: "zeko-service",
      serviceNetworkId: input.serviceNetworkId
    },
    facilitator: {
      mode: "multi-rail-preview",
      verifyUrl: input.plan.verifyPaymentUrl,
      settleUrl: input.plan.settlePaymentUrl
    },
    routes: [
      {
        method: "GET",
        resource: input.plan.resourcePreviewUrl,
        description: "Preview the rails SantaClawz would advertise for this agent once zeko-x402 execution is enabled.",
        mimeType: "application/json",
        accepts
      }
    ],
    features: [
      "multi-rail",
      "proof-aware-settlement-planning",
      "santaclawz-payment-profile"
    ],
    extensions: {
      santaclawz: {
        previewOnly: true,
        agentId: input.plan.agentId,
        sessionId: input.plan.sessionId,
        published: input.plan.published,
        paymentsEnabled: input.plan.paymentsEnabled,
        paymentProfileReady: input.plan.paymentProfileReady,
        payoutAddressConfigured: input.plan.payoutAddressConfigured,
        pricingMode: input.plan.pricingMode,
        settlementTrigger: input.plan.settlementTrigger,
        ...(input.plan.defaultRail ? { defaultRail: input.plan.defaultRail } : {}),
        ...(input.plan.quoteUrl ? { quoteUrl: input.plan.quoteUrl } : {}),
        ...(input.plan.paymentNotes ? { paymentNotes: input.plan.paymentNotes } : {}),
        incompleteRails: input.plan.rails.filter((rail) => !rail.ready).map(incompleteRailPreview)
      }
    }
  };
}

export function buildAgentX402PaymentRequiredPreview(input: {
  serviceNetworkId: string;
  plan: AgentX402Plan;
}) {
  const catalog = buildAgentX402CatalogPreview(input);
  const accepts = catalog.routes[0]?.accepts ?? [];

  return {
    protocol: "x402",
    version: "2",
    previewOnly: true,
    requestId: `preview_${input.plan.agentId}`,
    resource: input.plan.resourcePreviewUrl,
    description:
      "Preview x402 payment requirement generated from the stored SantaClawz payment profile. Live verification and settlement are not enabled yet.",
    mimeType: "application/json",
    seller: {
      serviceId: input.plan.serviceId
    },
    accepts,
    extensions: {
      santaclawz: {
        previewOnly: true,
        agentId: input.plan.agentId,
        sessionId: input.plan.sessionId,
        serviceNetworkId: input.serviceNetworkId,
        proofBundleUrl: input.plan.proofBundleUrl,
        verifyProofUrl: input.plan.verifyProofUrl,
        verifyPaymentUrl: input.plan.verifyPaymentUrl,
        settlePaymentUrl: input.plan.settlePaymentUrl,
        pricingMode: input.plan.pricingMode,
        settlementTrigger: input.plan.settlementTrigger
      }
    }
  };
}

function facilitatorTokenForBase(): string | undefined {
  return (
    process.env.CLAWZ_X402_BASE_FACILITATOR_BEARER_TOKEN?.trim() ||
    process.env.CLAWZ_X402_CDP_BEARER_TOKEN?.trim() ||
    process.env.COINBASE_CDP_API_BEARER_TOKEN?.trim() ||
    undefined
  );
}

function facilitatorTokenForEthereum(): string | undefined {
  return process.env.CLAWZ_X402_ETHEREUM_FACILITATOR_BEARER_TOKEN?.trim() || undefined;
}

function facilitatorClientForRail(rail: AgentX402RailPlan) {
  if (rail.rail === "base-usdc") {
    if (rail.facilitatorUrl) {
      return new HostedX402FacilitatorClient({
        baseUrl: rail.facilitatorUrl,
        ...(facilitatorTokenForBase() ? { bearerToken: facilitatorTokenForBase() } : {}),
        requireAuth: false
      });
    }

    if (facilitatorTokenForBase()) {
      return new CDPFacilitatorClient({
        bearerToken: facilitatorTokenForBase()
      });
    }

    return null;
  }

  if (rail.rail === "ethereum-usdc" && rail.facilitatorUrl) {
    return new HostedX402FacilitatorClient({
      baseUrl: rail.facilitatorUrl,
      ...(facilitatorTokenForEthereum() ? { bearerToken: facilitatorTokenForEthereum() } : {}),
      requireAuth: false
    });
  }

  return null;
}

function isLiveExactRail(plan: AgentX402Plan, rail: AgentX402RailPlan): boolean {
  return (
    rail.ready &&
    rail.executionMode === "settle-first" &&
    rail.settlementRail === "evm" &&
    plan.pricingMode === "fixed-exact" &&
    typeof rail.amountUsd === "string" &&
    rail.amountUsd.trim().length > 0
  );
}

function buildLiveRail(rail: AgentX402RailPlan): JsonRecord | null {
  if (!rail.payTo || !rail.amountUsd) {
    return null;
  }

  if (rail.rail === "base-usdc") {
    return buildBaseMainnetUsdcRail({
      payTo: rail.payTo,
      amount: rail.amountUsd,
      ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
    });
  }

  if (rail.rail === "ethereum-usdc") {
    return buildEthereumMainnetUsdcRail({
      payTo: rail.payTo,
      amount: rail.amountUsd,
      ...(rail.facilitatorUrl ? { facilitatorUrl: rail.facilitatorUrl } : {})
    });
  }

  return null;
}

export function buildAgentX402RuntimeContext(input: {
  baseUrl: string;
  plan: AgentX402Plan;
  serviceNetworkId: string;
}): AgentX402RuntimeContext | null {
  const runtimeRails = input.plan.rails.filter((rail) => isLiveExactRail(input.plan, rail));
  const rails = runtimeRails
    .map((rail) => buildLiveRail(rail))
    .filter((rail): rail is JsonRecord => Boolean(rail));

  if (rails.length === 0) {
    return null;
  }

  const paymentContext = {
    serviceId: input.plan.serviceId,
    serviceNetworkId: input.serviceNetworkId,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    proofBundleUrl: input.plan.proofBundleUrl,
    verifyUrl: input.plan.verifyProofUrl,
    sessionId: input.plan.sessionId,
    rails,
    description: "Paid SantaClawz proof bundle access for a registered OpenClaw agent."
  } satisfies JsonRecord;

  return {
    plan: input.plan,
    serviceNetworkId: input.serviceNetworkId,
    paymentContext,
    paymentRequired: buildPaymentRequired(paymentContext),
    catalog: buildCatalog(paymentContext),
    runtimeRails
  };
}

export function buildAgentX402Catalog(runtime: AgentX402RuntimeContext) {
  return runtime.catalog;
}

function paymentHeaders(input: {
  paymentRequired?: JsonRecord;
  paymentPayload?: JsonRecord;
  paymentResponse?: JsonRecord;
}) {
  return {
    ...(input.paymentRequired ? { [X402_PAYMENT_REQUIRED_HEADER]: encodeBase64Json(input.paymentRequired) } : {}),
    ...(input.paymentPayload ? { [X402_PAYMENT_SIGNATURE_HEADER]: encodeBase64Json(input.paymentPayload) } : {}),
    ...(input.paymentResponse ? { [X402_PAYMENT_RESPONSE_HEADER]: encodeBase64Json(input.paymentResponse) } : {})
  };
}

export function parseAgentX402PaymentPayload(input: {
  headerValue?: string;
  body?: unknown;
}): JsonRecord | null {
  if (typeof input.headerValue === "string" && input.headerValue.trim().length > 0) {
    return assertPaymentPayload(decodeBase64Json(input.headerValue.trim()));
  }

  if (isRecord(input.body) && isRecord(input.body.paymentPayload)) {
    return assertPaymentPayload(input.body.paymentPayload);
  }

  if (isRecord(input.body) && input.body.protocol === "x402") {
    return assertPaymentPayload(input.body);
  }

  return null;
}

function matchingRuntimeRail(context: AgentX402RuntimeContext, paymentPayload: JsonRecord): AgentX402RailPlan | null {
  return (
    context.runtimeRails.find(
      (rail) =>
        rail.networkId === paymentPayload.networkId &&
        rail.settlementRail === paymentPayload.settlementRail &&
        rail.payTo === paymentPayload.payTo
    ) ?? null
  );
}

function localVerificationOk(verification: JsonRecord): boolean {
  return verification.ok === true;
}

function remoteVerificationOk(verification: JsonRecord | undefined): boolean {
  if (!verification) {
    return false;
  }

  return verification.isValid !== false && verification.ok !== false;
}

function resultError(result: JsonRecord | undefined): string | undefined {
  if (!result) {
    return undefined;
  }

  const candidate = result.reason ?? result.invalidReason ?? result.error ?? result.errorReason ?? result.errorMessage;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function ledgerKeyFor(rail: AgentX402RailPlan): string {
  return `${rail.networkId}:${rail.assetSymbol}:${rail.assetAddress ?? rail.assetStandard}`;
}

function sponsoredBudgetForRail(rail: AgentX402RailPlan): string {
  if (rail.rail === "ethereum-usdc") {
    return process.env.CLAWZ_X402_ETHEREUM_SPONSORED_BUDGET_USDC?.trim() || process.env.CLAWZ_X402_SPONSORED_BUDGET_USDC?.trim() || "10";
  }

  return process.env.CLAWZ_X402_BASE_SPONSORED_BUDGET_USDC?.trim() || process.env.CLAWZ_X402_SPONSORED_BUDGET_USDC?.trim() || "10";
}

function settlementLedgerForRail(rail: AgentX402RailPlan) {
  const key = ledgerKeyFor(rail);
  const existing = settlementLedgers.get(key);
  if (existing) {
    return existing;
  }

  const ledger = new InMemorySettlementLedger({
    sponsoredBudget: sponsoredBudgetForRail(rail),
    budgetAsset: {
      symbol: rail.assetSymbol,
      decimals: rail.assetDecimals,
      standard: rail.assetStandard,
      ...(rail.assetAddress ? { address: rail.assetAddress } : {})
    }
  });
  settlementLedgers.set(key, ledger);
  return ledger;
}

function buildRemoteFacilitatorNote(rail: AgentX402RailPlan) {
  if (rail.rail === "base-usdc" && !rail.facilitatorUrl) {
    return "cdp";
  }

  return rail.facilitatorUrl ?? rail.facilitatorMode;
}

export function buildAgentX402Headers(input: {
  paymentRequired?: JsonRecord;
  paymentPayload?: JsonRecord;
  paymentResponse?: JsonRecord;
}) {
  return paymentHeaders(input);
}

export async function verifyAgentX402Payment(input: {
  runtime: AgentX402RuntimeContext;
  paymentPayload: JsonRecord;
}): Promise<AgentX402VerificationResult> {
  const rail = matchingRuntimeRail(input.runtime, input.paymentPayload);
  if (!rail) {
    return {
      ok: false,
      paymentRequired: input.runtime.paymentRequired,
      paymentPayload: input.paymentPayload,
      rail: input.runtime.runtimeRails[0]!,
      localVerification: { ok: false, reason: "Payment payload does not match any live SantaClawz x402 rail." },
      headers: paymentHeaders({
        paymentRequired: input.runtime.paymentRequired,
        paymentPayload: input.paymentPayload
      }),
      error: "Payment payload does not match any live SantaClawz x402 rail."
    };
  }

  const localVerification = verifyPayment({
    requirements: input.runtime.paymentRequired,
    payload: input.paymentPayload
  }) as JsonRecord;
  const headers = paymentHeaders({
    paymentRequired: input.runtime.paymentRequired,
    paymentPayload: input.paymentPayload
  });

  if (!localVerificationOk(localVerification)) {
    return {
      ok: false,
      paymentRequired: input.runtime.paymentRequired,
      paymentPayload: input.paymentPayload,
      rail,
      localVerification,
      headers,
      ...(resultError(localVerification) ? { error: resultError(localVerification)! } : {})
    };
  }

  const facilitator = facilitatorClientForRail(rail);
  if (!facilitator) {
    return {
      ok: false,
      paymentRequired: input.runtime.paymentRequired,
      paymentPayload: input.paymentPayload,
      rail,
      localVerification,
      headers,
      error: `No live facilitator is configured for ${rail.rail}.`
    };
  }

  const remoteVerification = (await facilitator.verify({
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.runtime.paymentRequired
  })) as JsonRecord;

  return {
    ok: remoteVerificationOk(remoteVerification),
    paymentRequired: input.runtime.paymentRequired,
    paymentPayload: input.paymentPayload,
    rail,
    localVerification,
    remoteVerification,
    headers,
    ...(!remoteVerificationOk(remoteVerification) && resultError(remoteVerification)
      ? { error: resultError(remoteVerification)! }
      : {})
  };
}

export async function settleAgentX402Payment(input: {
  runtime: AgentX402RuntimeContext;
  paymentPayload: JsonRecord;
}): Promise<AgentX402SettlementResult> {
  const verification = await verifyAgentX402Payment(input);
  if (!verification.ok || !verification.remoteVerification) {
    throw new Error(verification.error ?? "Unable to verify x402 payment.");
  }

  const facilitator = facilitatorClientForRail(verification.rail);
  if (!facilitator) {
    throw new Error(`No live facilitator is configured for ${verification.rail.rail}.`);
  }

  const remoteSettlement = (await facilitator.settle({
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.runtime.paymentRequired
  })) as JsonRecord;

  if (remoteSettlement.success === false || remoteSettlement.ok === false) {
    throw new Error(resultError(remoteSettlement) ?? "Facilitator failed to settle the x402 payment.");
  }

  const settlementReference = [
    remoteSettlement.transaction,
    remoteSettlement.txHash,
    remoteSettlement.transactionHash,
    remoteSettlement.id
  ].find((value): value is string => typeof value === "string" && value.length > 0);
  const ledger = settlementLedgerForRail(verification.rail);
  const ledgerResult = ledger.settle({
    ...input.paymentPayload,
    resource: input.runtime.paymentRequired.resource,
    ...(settlementReference ? { settlementReference } : {})
  }) as JsonRecord;

  const paymentResponse = buildSettlementResponse({
    payload: input.paymentPayload,
    duplicate: ledgerResult.duplicate,
    eventIds: ledgerResult.settlement && isRecord(ledgerResult.settlement) && Array.isArray(ledgerResult.settlement.eventIds)
      ? ledgerResult.settlement.eventIds
      : [],
    settledAtIso:
      ledgerResult.settlement && isRecord(ledgerResult.settlement) && typeof ledgerResult.settlement.settledAtIso === "string"
        ? ledgerResult.settlement.settledAtIso
        : new Date().toISOString(),
    remainingBudget: ledgerResult.remainingBudget,
    sponsoredBudget: ledgerResult.sponsoredBudget,
    budgetAsset: ledgerResult.budgetAsset,
    proofBundleUrl: input.runtime.plan.proofBundleUrl,
    verifyUrl: input.runtime.plan.verifyProofUrl,
    settlementModel: verification.rail.settlementModel,
    ...(settlementReference ? { settlementReference } : {}),
    evm: {
      networkId: verification.rail.networkId,
      facilitatorUrl: buildRemoteFacilitatorNote(verification.rail),
      verification: verification.remoteVerification,
      settlement: remoteSettlement
    }
  }) as JsonRecord;

  return {
    ...verification,
    remoteSettlement,
    paymentResponse,
    headers: paymentHeaders({
      paymentRequired: input.runtime.paymentRequired,
      paymentPayload: input.paymentPayload,
      paymentResponse
    })
  };
}
