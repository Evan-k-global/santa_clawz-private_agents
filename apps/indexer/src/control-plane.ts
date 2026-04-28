import { randomUUID } from "node:crypto";
import { existsSync } from "fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSealedBlobStore, type SealedBlobStore } from "@clawz/blob-store";
import { createTenantKeyBroker, type TenantKeyBrokerRuntimeDescriptor, TenantKeyBroker } from "@clawz/key-broker";
import {
  type AgentRegistryEntry,
  type AgentProfileState,
  type HireRequestReceipt,
  type SponsorQueueJob,
  type SponsorQueueState,
  TRUST_MODE_PRESETS,
  assertClawzEvent,
  sampleRetentionPolicy,
  type ArtifactSummary,
  type ClawzEvent,
  type ConsoleStateResponse,
  type LiveFlowDisclosureTarget,
  type LiveSessionTurnFlowState,
  type LiveFlowTargets,
  type LiveFlowTurnTarget,
  type PrivacyApprovalRecord,
  type PrivacyExceptionQueueItem,
  type ShadowWalletState,
  type TrustModeId,
  type ZekoContractDeployment,
  type ZekoDeploymentState
} from "@clawz/protocol";
import { buildGhostRunPlan } from "@clawz/worker-runtime";

import { ReplayMaterializer } from "./materializer.js";
import { sampleEvents } from "./sample-data.js";

const DEFAULT_TENANT_ID = "tenant_acme";
const DEFAULT_WORKSPACE_ID = "workspace_blue";
const DEFAULT_SESSION_ID = "session_demo_enterprise";
const DEFAULT_TURN_ID = "turn_0011";
type LiveFlowKind = "first-turn" | "next-turn" | "abort-turn" | "refund-turn" | "revoke-disclosure";

const LIVE_FLOW_METHODS: Record<LiveFlowKind, readonly string[]> = {
  "first-turn": [
    "SessionKernel.createSession",
    "TurnKernel.acquireLease",
    "ApprovalKernel.requestApproval",
    "ApprovalKernel.grantApproval",
    "EscrowKernel.reserveBudget",
    "TurnKernel.beginTurn",
    "TurnKernel.commitOutput",
    "EscrowKernel.settleTurn",
    "TurnKernel.finalizeTurn",
    "DisclosureKernel.grantDisclosure"
  ],
  "next-turn": [
    "SessionKernel.checkpointSession",
    "TurnKernel.acquireLease",
    "ApprovalKernel.requestApproval",
    "ApprovalKernel.grantApproval",
    "EscrowKernel.reserveBudget",
    "TurnKernel.beginTurn",
    "TurnKernel.commitOutput",
    "EscrowKernel.settleTurn",
    "TurnKernel.finalizeTurn",
    "DisclosureKernel.grantDisclosure"
  ],
  "abort-turn": ["ApprovalKernel.requestPrivacyException", "TurnKernel.abortTurn"],
  "refund-turn": ["EscrowKernel.refundTurn"],
  "revoke-disclosure": ["DisclosureKernel.revokeDisclosure"]
} as const;

const ALL_LIVE_FLOW_METHODS = Array.from(
  new Set(Object.values(LIVE_FLOW_METHODS).flatMap((methods) => methods))
);

interface ConsolePersistenceState {
  schemaVersion: 1;
  currentSessionId: string;
  activeMode: TrustModeId;
  wallet: ShadowWalletState;
  privacyExceptions: PrivacyExceptionQueueItem[];
  agentIdsBySession: Record<string, string>;
  profilesBySession: Record<string, AgentProfileState>;
}

interface DeploymentManifestFile {
  networkId?: string;
  mina?: string;
  archive?: string;
  fee?: string;
  deployer?: string;
  generatedAt?: string;
  witnessPlanPath?: string;
  preparedContractCalls?: number;
  preparedProofCalls?: number;
  results?: Array<{
    label?: string;
    address?: string | null;
    status?: string;
    txHash?: string;
    fundedNewAccount?: boolean;
    secretSource?: "env" | "keychain";
  }>;
}

interface WitnessPlanFile {
  scenarioId?: string;
  contracts?: Array<{
    kernel?: string;
    method?: string;
  }>;
  proofs?: unknown[];
}

interface LiveSessionTurnFlowReportFile {
  scenarioId?: string;
  sessionId?: string;
  turnId?: string;
  generatedAtIso?: string;
  reportType?: "live-session-turn-flow";
  steps?: Array<{
    label?: string;
    kernel?: string;
    method?: string;
    contractAddress?: string;
    txHash?: string;
    changedSlots?: number[];
    occurredAtIso?: string;
    args?: Record<string, string>;
    handles?: Record<string, string>;
  }>;
}

interface LiveSessionTurnFlowStatusFile {
  status: LiveSessionTurnFlowState["status"];
  flowKind?: LiveFlowKind;
  jobId?: string;
  scenarioId?: string;
  trustModeId?: TrustModeId;
  sessionId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
  baseSlot?: string;
  requestedAtIso?: string;
  lastStartedAtIso?: string;
  lastFinishedAtIso?: string;
  currentStepLabel?: string;
  completedStepLabels?: string[];
  totalSteps?: number;
  attemptCount?: number;
  resumeAvailable?: boolean;
  lastError?: string;
  witnessPlanPath?: string;
  reportPath?: string;
}

interface LiveSessionTurnRuntimeInput {
  jobId: string;
  flowKind?: LiveFlowKind;
  scenarioId?: string;
  sessionId: string;
  turnId: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
  tenantId: string;
  workspaceId: string;
  walletId: string;
  walletPublicKey: string;
  requestorKey?: string;
  workerId: string;
  baseSlot: string;
  trustModeId: TrustModeId;
  trustModeMaxSpendMina: string;
  sponsoredRemainingMina: string;
  requestedSpendMina?: string;
  defaultArtifactVisibility: (typeof TRUST_MODE_PRESETS)[number]["defaultArtifactVisibility"];
  operatorVisible: boolean;
  providerVisible: boolean;
  proofLevel: (typeof TRUST_MODE_PRESETS)[number]["proofLevel"];
  guardians: ShadowWalletState["guardians"];
  governancePolicy: ShadowWalletState["governancePolicy"];
  privacyExceptions: PrivacyExceptionQueueItem[];
}

interface LiveFlowRunOptions {
  flowKind?: LiveFlowKind;
  sessionId?: string;
  turnId?: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
}

interface SponsorWalletOptions {
  amountMina?: string;
  sessionId?: string;
  purpose?: SponsorQueueJob["purpose"];
}

interface RegisterAgentOptions {
  agentName: string;
  representedPrincipal?: string;
  headline: string;
  openClawUrl: string;
  payoutWallets?: AgentProfileState["payoutWallets"];
  paymentProfile?: Partial<AgentProfileState["paymentProfile"]>;
  payoutAddress?: string;
  trustModeId?: TrustModeId;
  preferredProvingLocation?: AgentProfileState["preferredProvingLocation"];
}

type AgentProfileInput = Partial<Omit<AgentProfileState, "paymentProfile">> & {
  paymentProfile?: Partial<AgentProfileState["paymentProfile"]>;
  payoutAddress?: unknown;
};

interface SubmitHireRequestOptions {
  agentId: string;
  taskPrompt: string;
  budgetMina?: string;
  requesterContact: string;
}

interface ConsoleStateOptions {
  sessionId?: string;
  agentId?: string;
}

interface EventListOptions {
  sessionId?: string;
  turnId?: string;
}

interface ResolvedSessionFocus {
  sessionId: string;
  focusSource: "requested" | "live-flow" | "latest-indexed" | "stored-default";
  knownSessionIds: string[];
  trustModeId: TrustModeId;
}

interface LiveSessionTurnFlowModule {
  executeLiveSessionTurnFlow: (options?: {
    workspaceRoot?: string;
    sessionId?: string;
    turnId?: string;
    witnessPlanPath?: string;
    reportPath?: string;
    runtimeInput?: LiveSessionTurnRuntimeInput;
    resume?: boolean;
    onStep?: (step: NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number]) => Promise<void> | void;
  }) => Promise<LiveSessionTurnFlowReportFile>;
}

interface SponsorQueueFile {
  jobs: SponsorQueueJob[];
}

interface HireRequestRecord {
  requestId: string;
  agentId: string;
  sessionId: string;
  networkId: string;
  submittedAtIso: string;
  status: "submitted";
  taskPrompt: string;
  budgetMina?: string;
  requesterContact: string;
  deliveryTarget: string;
}

interface HireRequestFile {
  requests: HireRequestRecord[];
}

function isLiveFlowKind(value: string): value is LiveFlowKind {
  return value in LIVE_FLOW_METHODS;
}

function isTrustModeId(value: string): value is TrustModeId {
  return TRUST_MODE_PRESETS.some((mode) => mode.id === value);
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

function toNanomina(value: string): bigint {
  const [whole = "0", fractional = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt((fractional + "000000000").slice(0, 9));
}

function fromNanomina(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fractional = `${value % 1_000_000_000n}`.padStart(9, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

function addMina(left: string, right: string): string {
  return fromNanomina(toNanomina(left) + toNanomina(right));
}

function subtractMina(left: string, right: string): string {
  const result = toNanomina(left) - toNanomina(right);
  return fromNanomina(result >= 0n ? result : 0n);
}

function plusHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface MutableLiveFlowTurnTarget extends LiveFlowTurnTarget {
  finalized: boolean;
  aborted: boolean;
  leased: boolean;
  started: boolean;
}

function buildWalletState(nowIso: string): ShadowWalletState {
  return {
    walletId: "shadow_wallet_acme_primary",
    publicKey: "B62qshadowwallet000000000000000000000000000000000000000000000000",
    deviceStatus: "device-bound",
    sponsorStatus: "active",
    sponsoredBudgetMina: "0.50",
    sponsoredRemainingMina: "0.50",
    trustModeId: "private",
    guardians: [
      {
        guardianId: "guardian_security",
        label: "Security Lead",
        role: "security",
        status: "active"
      },
      {
        guardianId: "guardian_legal",
        label: "Legal Counsel",
        role: "legal",
        status: "active"
      },
      {
        guardianId: "guardian_compliance",
        label: "Compliance Reviewer",
        role: "compliance",
        status: "active"
      }
    ],
    recovery: {
      status: "not-prepared",
      guardiansRequired: 2,
      lastRotationAtIso: nowIso
    },
    governancePolicy: {
      requiredApprovals: 2,
      reviewAudience: "Security + Compliance",
      autoExpiryHours: 24
    }
  };
}

function buildPrivacyApproval(actorId: PrivacyApprovalRecord["actorId"], actorRole: PrivacyApprovalRecord["actorRole"], note: string, approvedAtIso: string): PrivacyApprovalRecord {
  return {
    actorId,
    actorRole,
    note,
    approvedAtIso
  };
}

function buildPrivacyExceptions(nowIso: string): PrivacyExceptionQueueItem[] {
  return [
    {
      id: "privacy_exception_001",
      sessionId: DEFAULT_SESSION_ID,
      turnId: DEFAULT_TURN_ID,
      title: "Reveal one operator-blind artifact for incident review",
      audience: "Compliance reviewer",
      duration: "24h",
      scope: "One screenshot and one tool receipt",
      reason: "Investigate anomalous outbound host access without opening the full transcript.",
      severity: "high",
      status: "approved",
      requiredApprovals: 2,
      approvals: [
        buildPrivacyApproval("guardian_security", "workspace-member", "Security approved limited disclosure.", nowIso),
        buildPrivacyApproval("guardian_compliance", "compliance-reviewer", "Compliance approved 24h review window.", nowIso)
      ],
      expiresAtIso: plusHours(nowIso, 24)
    },
    {
      id: "privacy_exception_002",
      sessionId: DEFAULT_SESSION_ID,
      turnId: DEFAULT_TURN_ID,
      title: "Allow redacted remote provider fallback",
      audience: "Approved remote model",
      duration: "This turn only",
      scope: "Redacted prompt fields and citation digests",
      reason: "Local sealed provider is saturated and the task can safely route in digest mode.",
      severity: "medium",
      status: "pending",
      requiredApprovals: 2,
      approvals: [buildPrivacyApproval("guardian_security", "workspace-member", "Safe only if payload remains redacted.", nowIso)],
      expiresAtIso: plusHours(nowIso, 4)
    }
  ];
}

function buildDefaultState(nowIso: string): ConsolePersistenceState {
  return {
    schemaVersion: 1,
    currentSessionId: DEFAULT_SESSION_ID,
    activeMode: "private",
    wallet: buildWalletState(nowIso),
    privacyExceptions: buildPrivacyExceptions(nowIso),
    agentIdsBySession: {
      [DEFAULT_SESSION_ID]: buildStableAgentId("SantaClawz Operator", DEFAULT_SESSION_ID)
    },
    profilesBySession: {
      [DEFAULT_SESSION_ID]: buildDefaultProfile("private")
    }
  };
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "agent";
}

function buildStableAgentId(agentName: string, sessionId: string): string {
  return `${slugify(agentName)}--${sessionId}`;
}

function buildDefaultProfile(trustModeId: TrustModeId): AgentProfileState {
  const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
  return {
    agentName: "SantaClawz Operator",
    representedPrincipal: "Existing OpenClaw operator",
    headline: "Private, verifiable agent work on Zeko.",
    openClawUrl: "",
    payoutWallets: {},
    paymentProfile: {
      enabled: false,
      supportedRails: ["base-usdc"],
      defaultRail: "base-usdc",
      pricingMode: "fixed-exact",
      settlementTrigger: "upfront"
    },
    preferredProvingLocation: trustMode.defaultProvingLocation
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    const maybeCode = error as { code?: string };
    if (maybeCode.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

function buildDefaultSponsorQueue(): SponsorQueueFile {
  return {
    jobs: []
  };
}

function buildDefaultHireRequestFile(): HireRequestFile {
  return {
    requests: []
  };
}

function isMainnetNetwork(deployment: Pick<ZekoDeploymentState, "networkId" | "mode">): boolean {
  const networkId = deployment.networkId.toLowerCase();
  if (deployment.mode === "local-runtime" || deployment.mode === "planned-testnet" || deployment.mode === "testnet-live") {
    return false;
  }
  return networkId.includes("mainnet") && !networkId.includes("testnet");
}

function sanitizePayoutWalletValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 180) : undefined;
}

function sanitizeUsdAmount(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 40) : undefined;
}

function sanitizeUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 280) : undefined;
}

function sanitizePaymentNotes(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 280) : undefined;
}

function sanitizePayoutWallets(
  input: Partial<AgentProfileState["payoutWallets"]> | undefined,
  fallback: AgentProfileState["payoutWallets"],
  legacyPayoutAddress?: unknown
): AgentProfileState["payoutWallets"] {
  const zeko = sanitizePayoutWalletValue(input?.zeko) ?? sanitizePayoutWalletValue(fallback.zeko);
  const base =
    sanitizePayoutWalletValue(input?.base) ??
    sanitizePayoutWalletValue(legacyPayoutAddress) ??
    sanitizePayoutWalletValue(fallback.base);
  const ethereum = sanitizePayoutWalletValue(input?.ethereum) ?? sanitizePayoutWalletValue(fallback.ethereum);

  return {
    ...(zeko ? { zeko } : {}),
    ...(base ? { base } : {}),
    ...(ethereum ? { ethereum } : {})
  };
}

function hasPayoutAddress(profile: AgentProfileState): boolean {
  return Object.values(profile.payoutWallets).some((value) => typeof value === "string" && value.trim().length > 0);
}

function facilitatorUrlForRail(
  profile: AgentProfileState,
  rail: AgentProfileState["paymentProfile"]["supportedRails"][number]
): string | undefined {
  if (rail === "base-usdc") {
    return sanitizeUrl(profile.paymentProfile.baseFacilitatorUrl);
  }
  if (rail === "ethereum-usdc") {
    return sanitizeUrl(profile.paymentProfile.ethereumFacilitatorUrl);
  }
  return undefined;
}

function sanitizePaymentProfile(
  input: Partial<AgentProfileState["paymentProfile"]> | undefined,
  fallback: AgentProfileState["paymentProfile"]
): AgentProfileState["paymentProfile"] {
  const supportedRails = Array.from(
    new Set(
      (Array.isArray(input?.supportedRails) ? input.supportedRails : fallback.supportedRails).filter(
        (rail): rail is AgentProfileState["paymentProfile"]["supportedRails"][number] =>
          rail === "base-usdc" || rail === "ethereum-usdc" || rail === "zeko-native"
      )
    )
  );
  const normalizedRails: AgentProfileState["paymentProfile"]["supportedRails"] =
    supportedRails.length > 0 ? supportedRails : ["base-usdc"];
  const defaultRail =
    (input?.defaultRail && normalizedRails.includes(input.defaultRail) ? input.defaultRail : undefined) ??
    (fallback.defaultRail && normalizedRails.includes(fallback.defaultRail) ? fallback.defaultRail : undefined) ??
    normalizedRails[0];
  const pricingMode =
    input?.pricingMode === "fixed-exact" ||
    input?.pricingMode === "capped-exact" ||
    input?.pricingMode === "quote-required" ||
    input?.pricingMode === "agent-negotiated"
      ? input.pricingMode
      : fallback.pricingMode;
  const settlementTrigger =
    input?.settlementTrigger === "upfront" || input?.settlementTrigger === "on-proof"
      ? input.settlementTrigger
      : fallback.settlementTrigger;

  return {
    enabled: typeof input?.enabled === "boolean" ? input.enabled : fallback.enabled,
    supportedRails: normalizedRails,
    ...(defaultRail ? { defaultRail } : {}),
    pricingMode,
    ...(sanitizeUsdAmount(input?.fixedAmountUsd) ?? sanitizeUsdAmount(fallback.fixedAmountUsd)
      ? { fixedAmountUsd: sanitizeUsdAmount(input?.fixedAmountUsd) ?? sanitizeUsdAmount(fallback.fixedAmountUsd)! }
      : {}),
    ...(sanitizeUsdAmount(input?.maxAmountUsd) ?? sanitizeUsdAmount(fallback.maxAmountUsd)
      ? { maxAmountUsd: sanitizeUsdAmount(input?.maxAmountUsd) ?? sanitizeUsdAmount(fallback.maxAmountUsd)! }
      : {}),
    ...(sanitizeUrl(input?.quoteUrl) ?? sanitizeUrl(fallback.quoteUrl)
      ? { quoteUrl: sanitizeUrl(input?.quoteUrl) ?? sanitizeUrl(fallback.quoteUrl)! }
      : {}),
    settlementTrigger,
    ...(sanitizeUrl(input?.baseFacilitatorUrl) ?? sanitizeUrl(fallback.baseFacilitatorUrl)
      ? {
          baseFacilitatorUrl:
            sanitizeUrl(input?.baseFacilitatorUrl) ?? sanitizeUrl(fallback.baseFacilitatorUrl)!
        }
      : {}),
    ...(sanitizeUrl(input?.ethereumFacilitatorUrl) ?? sanitizeUrl(fallback.ethereumFacilitatorUrl)
      ? {
          ethereumFacilitatorUrl:
            sanitizeUrl(input?.ethereumFacilitatorUrl) ?? sanitizeUrl(fallback.ethereumFacilitatorUrl)!
        }
      : {}),
    ...(sanitizePaymentNotes(input?.paymentNotes) ?? sanitizePaymentNotes(fallback.paymentNotes)
      ? { paymentNotes: sanitizePaymentNotes(input?.paymentNotes) ?? sanitizePaymentNotes(fallback.paymentNotes)! }
      : {})
  };
}

function payoutWalletForRail(profile: AgentProfileState, rail: AgentProfileState["paymentProfile"]["supportedRails"][number]): string | undefined {
  if (rail === "base-usdc") {
    return profile.payoutWallets.base;
  }
  if (rail === "ethereum-usdc") {
    return profile.payoutWallets.ethereum;
  }
  return profile.payoutWallets.zeko;
}

function hasReadyPaymentProfile(profile: AgentProfileState): boolean {
  if (!profile.paymentProfile.enabled) {
    return false;
  }
  const selectedRail = profile.paymentProfile.defaultRail ?? profile.paymentProfile.supportedRails[0];
  if (!selectedRail || !payoutWalletForRail(profile, selectedRail)) {
    return false;
  }
  if (selectedRail === "zeko-native") {
    return false;
  }
  if (!facilitatorUrlForRail(profile, selectedRail)) {
    return false;
  }
  if (profile.paymentProfile.pricingMode === "fixed-exact") {
    return typeof profile.paymentProfile.fixedAmountUsd === "string" && profile.paymentProfile.fixedAmountUsd.trim().length > 0;
  }
  if (profile.paymentProfile.pricingMode === "capped-exact") {
    return typeof profile.paymentProfile.maxAmountUsd === "string" && profile.paymentProfile.maxAmountUsd.trim().length > 0;
  }
  return true;
}

function computePaidJobsEnabled(
  profile: AgentProfileState,
  published: boolean,
  deployment: Pick<ZekoDeploymentState, "networkId" | "mode">
): boolean {
  return published && hasReadyPaymentProfile(profile) && (!isMainnetNetwork(deployment) || hasPayoutAddress(profile));
}

export class ClawzControlPlane {
  private readonly statePath: string;
  private readonly eventsPath: string;
  private readonly workspaceRoot: string;
  private readonly deploymentManifestPath: string;
  private readonly deploymentWitnessPlanPath: string;
  private readonly legacyWitnessPlanPath: string;
  private readonly liveFlowReportPath: string;
  private readonly liveFlowPlanPath: string;
  private readonly liveFlowStatusPath: string;
  private readonly sponsorQueuePath: string;
  private readonly hireRequestPath: string;
  private readonly keyBroker: TenantKeyBroker;
  private readonly keyBrokerRuntime: TenantKeyBrokerRuntimeDescriptor;
  private readonly blobStore: SealedBlobStore;
  private liveFlowRunPromise: Promise<ConsoleStateResponse> | null = null;
  private sponsorQueueRunPromise: Promise<void> | null = null;

  constructor(private readonly baseDir: string) {
    this.workspaceRoot = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
    this.statePath = path.join(baseDir, "state", "console.json");
    this.eventsPath = path.join(baseDir, "state", "events.json");
    this.deploymentManifestPath = path.join(this.workspaceRoot, "packages", "contracts", "deployments", "latest-testnet.json");
    this.deploymentWitnessPlanPath = path.join(this.workspaceRoot, "packages", "contracts", "deployments", "latest-witness-plan.json");
    this.legacyWitnessPlanPath = path.join(this.workspaceRoot, "packages", "contracts", "artifacts", "deployment-witness-plan.json");
    this.liveFlowReportPath = path.join(this.workspaceRoot, "packages", "contracts", "deployments", "latest-session-turn-flow.json");
    this.liveFlowPlanPath = path.join(
      this.workspaceRoot,
      "packages",
      "contracts",
      "deployments",
      "latest-runtime-session-turn-plan.json"
    );
    this.liveFlowStatusPath = path.join(baseDir, "state", "live-session-turn-flow.json");
    this.sponsorQueuePath = path.join(baseDir, "state", "wallet-sponsor-queue.json");
    this.hireRequestPath = path.join(baseDir, "state", "hire-requests.json");
    this.keyBroker = createTenantKeyBroker({
      baseDir: path.join(baseDir, "kms"),
      wrappedKeyDir: path.join(baseDir, "kms", "wrapped-keys")
    });
    this.keyBrokerRuntime = this.keyBroker.getRuntimeDescriptor();
    this.blobStore = createSealedBlobStore({
      baseDir: path.join(baseDir, "blobs"),
      keyBroker: this.keyBroker
    });
  }

  static async boot(baseDir = path.join(process.cwd(), ".clawz-data")): Promise<ClawzControlPlane> {
    const controlPlane = new ClawzControlPlane(baseDir);
    await controlPlane.ensureBootstrapped();
    return controlPlane;
  }

  private async ensureDirs() {
    await mkdir(path.join(this.baseDir, "state"), { recursive: true, mode: 0o700 });
    await this.blobStore.ensureDirs();
  }

  private async loadState(): Promise<ConsolePersistenceState> {
    await this.ensureDirs();
    const state = await readJsonFile<ConsolePersistenceState>(this.statePath);
    if (state) {
      const migratedState: ConsolePersistenceState = {
        ...state,
        schemaVersion: 1,
        agentIdsBySession:
          state.agentIdsBySession && Object.keys(state.agentIdsBySession).length > 0
            ? state.agentIdsBySession
            : Object.fromEntries(
                Object.entries(
                  state.profilesBySession && Object.keys(state.profilesBySession).length > 0
                    ? state.profilesBySession
                    : {
                        [state.currentSessionId]: buildDefaultProfile(state.activeMode)
                      }
                ).map(([sessionId, profile]) => [sessionId, buildStableAgentId(profile.agentName, sessionId)])
              ),
        profilesBySession:
          state.profilesBySession && Object.keys(state.profilesBySession).length > 0
            ? state.profilesBySession
            : {
                [state.currentSessionId]: buildDefaultProfile(state.activeMode)
              }
      };
      if (
        state.schemaVersion !== 1 ||
        !state.agentIdsBySession ||
        Object.keys(state.agentIdsBySession).length === 0 ||
        !state.profilesBySession ||
        Object.keys(state.profilesBySession).length === 0
      ) {
        await this.saveState(migratedState);
      }
      return migratedState;
    }

    const fallback = buildDefaultState(new Date().toISOString());
    await this.saveState(fallback);
    return fallback;
  }

  private async saveState(state: ConsolePersistenceState) {
    await this.ensureDirs();
    await writeJsonFile(this.statePath, state);
  }

  private async loadEvents(): Promise<ClawzEvent[]> {
    await this.ensureDirs();
    const events = await readJsonFile<ClawzEvent[]>(this.eventsPath);
    return events ?? [];
  }

  private async loadDeploymentManifest(): Promise<DeploymentManifestFile | undefined> {
    return readJsonFile<DeploymentManifestFile>(this.deploymentManifestPath);
  }

  private async loadWitnessPlan(manifest?: DeploymentManifestFile): Promise<WitnessPlanFile | undefined> {
    const candidates = [
      typeof manifest?.witnessPlanPath === "string" ? manifest.witnessPlanPath : undefined,
      this.deploymentWitnessPlanPath,
      this.legacyWitnessPlanPath
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      const plan = await readJsonFile<WitnessPlanFile>(candidate);
      if (plan) {
        return plan;
      }
    }

    return undefined;
  }

  private async loadLiveFlowReport(): Promise<LiveSessionTurnFlowReportFile | undefined> {
    return readJsonFile<LiveSessionTurnFlowReportFile>(this.liveFlowReportPath);
  }

  private async loadLiveFlowStatus(): Promise<LiveSessionTurnFlowStatusFile | undefined> {
    await this.ensureDirs();
    return readJsonFile<LiveSessionTurnFlowStatusFile>(this.liveFlowStatusPath);
  }

  private async saveLiveFlowStatus(status: LiveSessionTurnFlowStatusFile) {
    await this.ensureDirs();
    await writeJsonFile(this.liveFlowStatusPath, status);
  }

  private async loadSponsorQueueFile(): Promise<SponsorQueueFile> {
    await this.ensureDirs();
    const queue = await readJsonFile<SponsorQueueFile>(this.sponsorQueuePath);
    if (queue?.jobs) {
      return queue;
    }

    const fallback = buildDefaultSponsorQueue();
    await this.saveSponsorQueueFile(fallback);
    return fallback;
  }

  private async saveSponsorQueueFile(queue: SponsorQueueFile) {
    await this.ensureDirs();
    await writeJsonFile(this.sponsorQueuePath, queue);
  }

  private async loadHireRequestFile(): Promise<HireRequestFile> {
    await this.ensureDirs();
    const file = await readJsonFile<HireRequestFile>(this.hireRequestPath);
    if (file?.requests) {
      return file;
    }

    const fallback = buildDefaultHireRequestFile();
    await this.saveHireRequestFile(fallback);
    return fallback;
  }

  private async saveHireRequestFile(file: HireRequestFile) {
    await this.ensureDirs();
    await writeJsonFile(this.hireRequestPath, file);
  }

  private async saveEvents(events: ClawzEvent[]) {
    await this.ensureDirs();
    await writeJsonFile(this.eventsPath, events);
  }

  private async appendEvent(type: ClawzEvent["type"], payload: Record<string, unknown>, occurredAtIso = new Date().toISOString()) {
    const events = await this.loadEvents();
    const nextEvent: ClawzEvent = {
      id: `evt_${String(events.length + 1).padStart(4, "0")}`,
      type,
      occurredAtIso,
      payload
    };
    events.push(nextEvent);
    await this.saveEvents(events);
    return nextEvent;
  }

  private applyFocusedSession(
    state: ConsolePersistenceState,
    sessionId: string,
    trustModeId = state.activeMode
  ): ConsolePersistenceState {
    return {
      ...state,
      currentSessionId: sessionId,
      activeMode: trustModeId,
      wallet: {
        ...state.wallet,
        trustModeId
      }
    };
  }

  private profileForSession(state: ConsolePersistenceState, sessionId: string, trustModeId = state.activeMode): AgentProfileState {
    return this.sanitizeProfileInput(trustModeId, state.profilesBySession[sessionId] ?? {}, buildDefaultProfile(trustModeId));
  }

  private agentIdForSession(state: ConsolePersistenceState, sessionId: string, trustModeId = state.activeMode): string {
    return (
      state.agentIdsBySession[sessionId] ??
      buildStableAgentId(this.profileForSession(state, sessionId, trustModeId).agentName, sessionId)
    );
  }

  private resolveSessionIdFromAgentId(state: ConsolePersistenceState, agentId: string): string | undefined {
    return Object.entries(state.agentIdsBySession).find(([, value]) => value === agentId)?.[0];
  }

  private sanitizeProfileInput(
    trustModeId: TrustModeId,
    input: AgentProfileInput,
    fallback: AgentProfileState
  ): AgentProfileState {
    const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
    const preferredProvingLocation =
      input.preferredProvingLocation && trustMode.supportedProvingLocations.includes(input.preferredProvingLocation)
        ? input.preferredProvingLocation
        : fallback.preferredProvingLocation;
    const legacyPayoutAddress = (input as { payoutAddress?: unknown }).payoutAddress;

    return {
      agentName: typeof input.agentName === "string" ? input.agentName.trim().slice(0, 120) : fallback.agentName,
      representedPrincipal:
        typeof input.representedPrincipal === "string"
          ? input.representedPrincipal.trim().slice(0, 160)
          : fallback.representedPrincipal,
      headline: typeof input.headline === "string" ? input.headline.trim().slice(0, 280) : fallback.headline,
      openClawUrl: typeof input.openClawUrl === "string" ? input.openClawUrl.trim().slice(0, 280) : fallback.openClawUrl,
      payoutWallets: sanitizePayoutWallets(input.payoutWallets, fallback.payoutWallets, legacyPayoutAddress),
      paymentProfile: sanitizePaymentProfile(input.paymentProfile, fallback.paymentProfile),
      preferredProvingLocation
    };
  }

  private resolveSessionTrustMode(
    events: ClawzEvent[],
    sessionId: string | undefined,
    fallback: TrustModeId
  ): TrustModeId {
    if (!sessionId) {
      return fallback;
    }

    const matchingEvent = [...events]
      .reverse()
      .find((event) => {
        const payload = event.payload as Record<string, unknown>;
        return payload.sessionId === sessionId && typeof payload.trustMode === "string" && isTrustModeId(payload.trustMode);
      });

    const trustMode = matchingEvent ? (matchingEvent.payload as Record<string, unknown>).trustMode : undefined;
    return typeof trustMode === "string" && isTrustModeId(trustMode) ? trustMode : fallback;
  }

  private buildKnownSessionIds(
    state: ConsolePersistenceState,
    events: ClawzEvent[]
  ): string[] {
    const recency = new Map<string, string>();
    const remember = (sessionId: string | undefined, occurredAtIso?: string) => {
      if (!sessionId) {
        return;
      }

      const existing = recency.get(sessionId);
      if (!existing || (occurredAtIso ?? "") > existing) {
        recency.set(sessionId, occurredAtIso ?? existing ?? "");
      }
    };

    remember(state.currentSessionId);
    events.forEach((event) => {
      const payload = event.payload as Record<string, unknown>;
      remember(asString(payload.sessionId), event.occurredAtIso);
    });

    return [...recency.entries()]
      .sort((left, right) => {
        const byRecency = right[1].localeCompare(left[1]);
        if (byRecency !== 0) {
          return byRecency;
        }
        if (left[0] === state.currentSessionId) {
          return -1;
        }
        if (right[0] === state.currentSessionId) {
          return 1;
        }
        return left[0].localeCompare(right[0]);
      })
      .map(([sessionId]) => sessionId);
  }

  private resolveSessionFocus(
    state: ConsolePersistenceState,
    events: ClawzEvent[],
    liveFlowTargets: LiveFlowTargets,
    liveFlow: LiveSessionTurnFlowState,
    requestedSessionId?: string
  ): ResolvedSessionFocus {
    const knownSessionIds = this.buildKnownSessionIds(state, events);

    if (requestedSessionId) {
      if (!knownSessionIds.includes(requestedSessionId)) {
        throw new Error(`Unknown session: ${requestedSessionId}`);
      }

      return {
        sessionId: requestedSessionId,
        focusSource: "requested",
        knownSessionIds,
        trustModeId: this.resolveSessionTrustMode(events, requestedSessionId, state.activeMode)
      };
    }

    if (
      liveFlow.status !== "idle" &&
      liveFlow.jobId &&
      liveFlow.sessionId &&
      knownSessionIds.includes(liveFlow.sessionId)
    ) {
      return {
        sessionId: liveFlow.sessionId,
        focusSource: "live-flow",
        knownSessionIds,
        trustModeId: this.resolveSessionTrustMode(events, liveFlow.sessionId, state.activeMode)
      };
    }

    const indexedSessionId =
      liveFlowTargets.turns.find((target) => knownSessionIds.includes(target.sessionId))?.sessionId ?? knownSessionIds[0];
    if (indexedSessionId) {
      return {
        sessionId: indexedSessionId,
        focusSource: "latest-indexed",
        knownSessionIds,
        trustModeId: this.resolveSessionTrustMode(events, indexedSessionId, state.activeMode)
      };
    }

    return {
      sessionId: state.currentSessionId,
      focusSource: "stored-default",
      knownSessionIds: [state.currentSessionId],
      trustModeId: state.activeMode
    };
  }

  private filterEvents(events: ClawzEvent[], options: EventListOptions = {}): ClawzEvent[] {
    return events.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      if (options.sessionId && payload.sessionId !== options.sessionId) {
        return false;
      }
      if (options.turnId && payload.turnId !== options.turnId) {
        return false;
      }
      return true;
    });
  }

  private async ensureBootstrapped() {
    await this.ensureDirs();
    const existingEvents = await this.loadEvents();
    const state = await this.loadState();
    await this.loadSponsorQueueFile();
    await this.loadHireRequestFile();

    if (existingEvents.length === 0) {
      await this.saveEvents(sampleEvents);
    }

    const manifests = await this.blobStore.listManifests(state.currentSessionId);
    if (manifests.length === 0) {
      const manifest = await this.blobStore.sealJson({
        scope: {
          tenantId: DEFAULT_TENANT_ID,
          workspaceId: DEFAULT_WORKSPACE_ID,
          sessionId: DEFAULT_SESSION_ID,
          turnId: DEFAULT_TURN_ID
        },
        visibility: "operator-blind",
        retentionPolicy: sampleRetentionPolicy,
        sessionId: DEFAULT_SESSION_ID,
        turnId: DEFAULT_TURN_ID,
        artifactClass: "summary",
        payload: {
          headline: "Operator-blind enterprise summary",
          insight: "One artifact persisted locally with durable key wrapping and manifest metadata.",
          controls: ["team sealed", "digest receipts", "24h artifact ttl"]
        }
      });

      await this.appendEvent("ArtifactSealed", {
        sessionId: DEFAULT_SESSION_ID,
        turnId: DEFAULT_TURN_ID,
        manifestId: manifest.manifestId,
        artifactClass: manifest.artifactClass,
        payloadDigest: manifest.payloadDigest,
        visibility: manifest.visibility
      });
    }
  }

  private normalizePrivacyExceptions(state: ConsolePersistenceState, nowIso = new Date().toISOString()): PrivacyExceptionQueueItem[] {
    let changed = false;
    const next = state.privacyExceptions.map((item) => {
      if (item.status !== "expired" && item.expiresAtIso <= nowIso) {
        changed = true;
        return {
          ...item,
          status: "expired" as const
        };
      }
      return item;
    });

    if (changed) {
      void this.saveState({
        ...state,
        privacyExceptions: next
      });
    }

    return next;
  }

  async getDeploymentState(): Promise<ZekoDeploymentState> {
    const manifest = await this.loadDeploymentManifest();
    const witnessPlan = await this.loadWitnessPlan(manifest);
    const contracts = (manifest?.results ?? []).map<ZekoContractDeployment>((result) => ({
      label: typeof result.label === "string" ? result.label : "UnknownKernel",
      status: result.status === "deployed" || result.status === "skipped" ? result.status : "unavailable",
      ...(typeof result.address === "string" && result.address.length > 0 ? { address: result.address } : {}),
      ...(typeof result.txHash === "string" && result.txHash.length > 0 ? { txHash: result.txHash } : {}),
      ...(typeof result.fundedNewAccount === "boolean" ? { fundedNewAccount: result.fundedNewAccount } : {}),
      ...(result.secretSource ? { secretSource: result.secretSource } : {})
    }));
    const hasLiveContracts = contracts.some((contract) => contract.status === "deployed" && Boolean(contract.address));
    const witnessMethods = new Set(
      (witnessPlan?.contracts ?? [])
        .map((entry) =>
          typeof entry.kernel === "string" && typeof entry.method === "string"
            ? `${entry.kernel}.${entry.method}`
            : undefined
        )
        .filter((value): value is string => Boolean(value))
    );
    const privacyGrade = this.keyBrokerRuntime.mode === "in-memory-default-export" ? "pilot-grade" : "production-grade";
    const privacyNote =
      this.keyBrokerRuntime.mode === "external-kms-backed"
        ? "ClawZ is running with an external KMS boundary for workspace keys, durable wrapped-key persistence, and sealed blob manifests. This is the preferred enterprise mode when backed by a managed KMS or HSM service."
        : this.keyBrokerRuntime.mode === "durable-local-file-backed"
          ? "ClawZ is running with durable local tenant keys, wrapped-key persistence, and sealed blob manifests by default. For regulated deployments, switch the same interface boundary to external-kms-backed mode."
          : "ClawZ is running in explicit in-memory privacy mode for isolated testing. Durable local or external KMS-backed key storage should back any real operator or testnet environment.";

    return {
      chain: "zeko",
      networkId: manifest?.networkId ?? process.env.ZEKO_NETWORK_ID ?? "testnet",
      mode: hasLiveContracts ? "testnet-live" : process.env.ZEKO_GRAPHQL ? "planned-testnet" : "local-runtime",
      graphqlEndpoint: manifest?.mina ?? process.env.ZEKO_GRAPHQL ?? "https://testnet.zeko.io/graphql",
      archiveEndpoint: manifest?.archive ?? process.env.ZEKO_ARCHIVE ?? "https://archive.testnet.zeko.io/graphql",
      ...(typeof manifest?.deployer === "string" ? { deployerPublicKey: manifest.deployer } : {}),
      ...(typeof manifest?.generatedAt === "string" ? { generatedAtIso: manifest.generatedAt } : {}),
      contracts,
      witnessPlan: {
        ...(typeof witnessPlan?.scenarioId === "string" ? { scenarioId: witnessPlan.scenarioId } : {}),
        preparedContractCalls:
          typeof manifest?.preparedContractCalls === "number"
            ? manifest.preparedContractCalls
            : (witnessPlan?.contracts?.length ?? 0),
        preparedProofCalls:
          typeof manifest?.preparedProofCalls === "number"
            ? manifest.preparedProofCalls
            : (witnessPlan?.proofs?.length ?? 0),
        liveFlowMethods: ALL_LIVE_FLOW_METHODS.filter((method) => witnessMethods.has(method))
      },
      privacyGrade,
      keyManagement: this.keyBrokerRuntime.mode,
      privacyNote
    };
  }

  private flowMethodsFor(flowKind: LiveFlowKind = "first-turn") {
    return LIVE_FLOW_METHODS[flowKind];
  }

  private nextLiveFlowLabel(flowKind: LiveFlowKind, completedStepLabels: string[]): string | undefined {
    return this.flowMethodsFor(flowKind)[completedStepLabels.length];
  }

  private matchesRequestedLiveFlow(
    status: LiveSessionTurnFlowStatusFile,
    options: LiveFlowRunOptions = {}
  ): boolean {
    const requestedFlowKind = options.flowKind ?? status.flowKind ?? "first-turn";

    return (
      (status.flowKind ?? "first-turn") === requestedFlowKind &&
      (!options.sessionId || status.sessionId === options.sessionId) &&
      (!options.turnId || status.turnId === options.turnId) &&
      (!options.sourceTurnId || status.sourceTurnId === options.sourceTurnId) &&
      (!options.sourceDisclosureId || status.sourceDisclosureId === options.sourceDisclosureId) &&
      (!options.abortReason || status.abortReason === options.abortReason) &&
      (!options.revocationReason || status.revocationReason === options.revocationReason) &&
      (!options.refundAmountMina || status.refundAmountMina === options.refundAmountMina)
    );
  }

  private canResumeLiveFlow(status?: LiveSessionTurnFlowStatusFile, options: LiveFlowRunOptions = {}): boolean {
    const resolvedFlowKind = options.flowKind ?? status?.flowKind ?? "first-turn";

    return Boolean(
      status &&
        status.status === "failed" &&
        this.matchesRequestedLiveFlow(status, options) &&
        status.jobId &&
        status.sessionId &&
        status.turnId &&
        status.witnessPlanPath &&
        (status.completedStepLabels?.length ?? 0) < this.flowMethodsFor(resolvedFlowKind).length
    );
  }

  private buildLiveFlowJob(
    state: ConsolePersistenceState,
    requestedAtIso: string,
    options: LiveFlowRunOptions,
    liveFlowState: LiveSessionTurnFlowState,
    trustModeId: TrustModeId
  ): LiveSessionTurnFlowStatusFile {
    const flowKind = options.flowKind ?? "first-turn";
    const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
    const slug = randomUUID().replace(/-/g, "").slice(0, 12);
    const baseSlot = String(Math.floor(Date.parse(requestedAtIso) / 1000));
    const totalSteps = this.flowMethodsFor(flowKind).length;
    const priorSessionId = liveFlowState.sessionId || state.currentSessionId;
    const priorTurnId = liveFlowState.turnId || DEFAULT_TURN_ID;
    const priorDisclosureId =
      liveFlowState.jobId && priorTurnId ? `${priorTurnId}:disclosure:${liveFlowState.jobId}` : undefined;
    const sessionId = options.sessionId ?? (flowKind === "first-turn" ? `session_live_${slug}` : priorSessionId);
    const turnId =
      options.turnId ??
      (flowKind === "first-turn" || flowKind === "next-turn" ? `turn_live_${slug}` : priorTurnId);
    const sourceTurnId = options.sourceTurnId ?? (flowKind === "next-turn" ? priorTurnId : undefined);
    const sourceDisclosureId =
      options.sourceDisclosureId ?? (flowKind === "revoke-disclosure" ? priorDisclosureId : undefined);

    return {
      status: "queued",
      flowKind,
      jobId: `live_flow_${slug}`,
      scenarioId: `runtime-${flowKind}-${trustMode.id}-${slug}`,
      trustModeId: trustMode.id,
      sessionId,
      turnId,
      ...(sourceTurnId ? { sourceTurnId } : {}),
      ...(sourceDisclosureId ? { sourceDisclosureId } : {}),
      ...(options.abortReason ? { abortReason: options.abortReason } : {}),
      ...(options.revocationReason ? { revocationReason: options.revocationReason } : {}),
      ...(options.refundAmountMina ? { refundAmountMina: options.refundAmountMina } : {}),
      baseSlot,
      requestedAtIso,
      completedStepLabels: [],
      totalSteps,
      attemptCount: 1,
      resumeAvailable: false,
      witnessPlanPath: this.liveFlowPlanPath,
      reportPath: this.liveFlowReportPath
    };
  }

  private buildRuntimeLiveFlowInput(
    state: ConsolePersistenceState,
    privacyExceptions: PrivacyExceptionQueueItem[],
    job: LiveSessionTurnFlowStatusFile
  ): LiveSessionTurnRuntimeInput {
    const trustModeId = job.trustModeId ?? state.activeMode;
    const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
    const jobId = job.jobId;
    const sessionId = job.sessionId;
    const turnId = job.turnId;
    const baseSlot = job.baseSlot;
    const flowKind = job.flowKind ?? "first-turn";

    if (!jobId || !sessionId || !turnId || !baseSlot) {
      throw new Error("Live flow job is missing required runtime identifiers.");
    }

    return {
      jobId,
      flowKind,
      ...(job.scenarioId ? { scenarioId: job.scenarioId } : {}),
      sessionId,
      turnId,
      ...(job.sourceTurnId ? { sourceTurnId: job.sourceTurnId } : {}),
      ...(job.sourceDisclosureId ? { sourceDisclosureId: job.sourceDisclosureId } : {}),
      ...(job.abortReason ? { abortReason: job.abortReason } : {}),
      ...(job.revocationReason ? { revocationReason: job.revocationReason } : {}),
      ...(job.refundAmountMina ? { refundAmountMina: job.refundAmountMina } : {}),
      tenantId: DEFAULT_TENANT_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      walletId: state.wallet.walletId,
      walletPublicKey: state.wallet.publicKey,
      requestorKey: state.wallet.publicKey,
      workerId: `worker_${trustMode.id}_${jobId.slice(-6)}`,
      baseSlot,
      trustModeId: trustMode.id,
      trustModeMaxSpendMina: trustMode.maxSpendMina,
      sponsoredRemainingMina: state.wallet.sponsoredRemainingMina,
      requestedSpendMina: state.wallet.sponsoredRemainingMina,
      defaultArtifactVisibility: trustMode.defaultArtifactVisibility,
      operatorVisible: trustMode.operatorVisible,
      providerVisible: trustMode.providerVisible,
      proofLevel: trustMode.proofLevel,
      guardians: state.wallet.guardians,
      governancePolicy: state.wallet.governancePolicy,
      privacyExceptions
    };
  }

  async getLiveFlowState(): Promise<LiveSessionTurnFlowState> {
    const [report, status] = await Promise.all([this.loadLiveFlowReport(), this.loadLiveFlowStatus()]);
    const flowKind = status?.flowKind ?? "first-turn";
    const completedStepLabels = status?.completedStepLabels ?? (report?.steps ?? []).map((step) => step.label ?? "");
    const sanitizedCompletedStepLabels = completedStepLabels.filter((label): label is string => label.length > 0);
    const resolvedStatus = status?.status ?? (report ? "succeeded" : "idle");
    const totalSteps = status?.totalSteps ?? this.flowMethodsFor(flowKind).length;
    const resumeAvailable = status?.resumeAvailable ?? this.canResumeLiveFlow(status, { flowKind });
    const resumeFromStepLabel =
      resumeAvailable ? this.nextLiveFlowLabel(flowKind, sanitizedCompletedStepLabels) : undefined;
    const stepCount = Math.max(report?.steps?.length ?? 0, sanitizedCompletedStepLabels.length);

    return {
      flowKind,
      scenarioId: report?.scenarioId ?? "demo-enterprise-private-run",
      sessionId: status?.sessionId ?? report?.sessionId ?? DEFAULT_SESSION_ID,
      turnId: status?.turnId ?? report?.turnId ?? DEFAULT_TURN_ID,
      status: resolvedStatus,
      stepCount,
      totalSteps,
      steps: (report?.steps ?? [])
        .filter(
          (step): step is NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number] &
            { label: string; contractAddress: string; txHash: string; changedSlots: number[] } =>
            typeof step.label === "string" &&
            typeof step.contractAddress === "string" &&
            typeof step.txHash === "string" &&
            Array.isArray(step.changedSlots)
        )
        .map((step) => ({
          label: step.label,
          contractAddress: step.contractAddress,
          txHash: step.txHash,
          changedSlots: step.changedSlots,
          ...(typeof step.occurredAtIso === "string" ? { occurredAtIso: step.occurredAtIso } : {})
        })),
      completedStepLabels: sanitizedCompletedStepLabels,
      ...(report?.reportType ? { reportType: report.reportType } : {}),
      ...(report?.generatedAtIso ? { generatedAtIso: report.generatedAtIso } : {}),
      ...(status?.requestedAtIso ? { requestedAtIso: status.requestedAtIso } : {}),
      ...(status?.lastStartedAtIso ? { lastStartedAtIso: status.lastStartedAtIso } : {}),
      ...(status?.lastFinishedAtIso ? { lastFinishedAtIso: status.lastFinishedAtIso } : {}),
      ...(status?.sourceTurnId ? { sourceTurnId: status.sourceTurnId } : {}),
      ...(status?.sourceDisclosureId ? { sourceDisclosureId: status.sourceDisclosureId } : {}),
      ...(status?.abortReason ? { abortReason: status.abortReason } : {}),
      ...(status?.revocationReason ? { revocationReason: status.revocationReason } : {}),
      ...(status?.refundAmountMina ? { refundAmountMina: status.refundAmountMina } : {}),
      ...(status?.currentStepLabel ? { currentStepLabel: status.currentStepLabel } : {}),
      ...(resumeFromStepLabel ? { resumeFromStepLabel } : {}),
      ...(status?.lastError ? { lastError: status.lastError } : {}),
      ...(typeof status?.attemptCount === "number" ? { attemptCount: status.attemptCount } : {}),
      ...(resumeAvailable ? { resumeAvailable } : { resumeAvailable: false }),
      ...(status?.jobId ? { jobId: status.jobId } : {}),
      ...(report || status?.reportPath ? { reportPath: status?.reportPath ?? this.liveFlowReportPath } : {}),
      ...(status?.witnessPlanPath ? { witnessPlanPath: status.witnessPlanPath } : {})
    };
  }

  async getSponsorQueueState(sessionId?: string): Promise<SponsorQueueState> {
    const queue = await this.loadSponsorQueueFile();
    return this.buildSponsorQueueState(queue, sessionId);
  }

  private buildSponsorQueueState(queue: SponsorQueueFile, sessionId?: string): SponsorQueueState {
    const visibleJobs = (sessionId ? queue.jobs.filter((job) => job.sessionId === sessionId) : queue.jobs).sort((left, right) =>
      right.requestedAtIso.localeCompare(left.requestedAtIso)
    );
    const activeJob = visibleJobs.find((job) => job.status === "running");
    const pendingCount = visibleJobs.filter((job) => job.status === "queued" || job.status === "running").length;
    const latestJob = visibleJobs[0];
    const status: SponsorQueueState["status"] = activeJob
      ? "running"
      : visibleJobs.some((job) => job.status === "queued")
        ? "queued"
        : latestJob?.status === "failed"
          ? "failed"
          : "idle";

    return {
      status,
      autoSponsorEnabled: true,
      pendingCount,
      ...(activeJob ? { activeJobId: activeJob.jobId } : {}),
      items: visibleJobs.slice(0, 8)
    };
  }

  private async runSponsorQueue(): Promise<void> {
    if (this.sponsorQueueRunPromise) {
      return this.sponsorQueueRunPromise;
    }

    this.sponsorQueueRunPromise = (async () => {
      while (true) {
        const queue = await this.loadSponsorQueueFile();
        const nextJob = queue.jobs.find((job) => job.status === "queued");

        if (!nextJob) {
          break;
        }

        const startedAtIso = new Date().toISOString();
        const runningJob: SponsorQueueJob = {
          ...nextJob,
          status: "running",
          startedAtIso,
          note: "Submitting sponsor top-up through the SantaClawz treasury queue."
        };

        await this.saveSponsorQueueFile({
          jobs: queue.jobs.map((job) => (job.jobId === nextJob.jobId ? runningJob : job))
        });

        try {
          const state = await this.loadState();
          const txHash = `sponsor_${nextJob.jobId.slice(-12)}`;
          const finishedAtIso = new Date().toISOString();
          const nextState: ConsolePersistenceState = {
            ...state,
            wallet: {
              ...state.wallet,
              sponsorStatus: "active",
              sponsoredBudgetMina: addMina(state.wallet.sponsoredBudgetMina, nextJob.amountMina),
              sponsoredRemainingMina: addMina(state.wallet.sponsoredRemainingMina, nextJob.amountMina)
            }
          };

          await this.saveState(nextState);
          await this.appendEvent(
            "CreditsDeposited",
            {
              walletId: nextState.wallet.walletId,
              amountMina: nextJob.amountMina,
              budgetAfterMina: nextState.wallet.sponsoredBudgetMina,
              sessionId: nextJob.sessionId,
              sponsorJobId: nextJob.jobId,
              sponsorTxHash: txHash,
              sponsorPurpose: nextJob.purpose
            },
            finishedAtIso
          );

          const refreshedQueue = await this.loadSponsorQueueFile();
          await this.saveSponsorQueueFile({
            jobs: refreshedQueue.jobs.map((job) =>
              job.jobId === nextJob.jobId
                ? {
                    ...runningJob,
                    status: "succeeded",
                    finishedAtIso,
                    txHash,
                    note: `Sponsored ${nextJob.amountMina} MINA for ${nextJob.purpose}.`
                  }
                : job
            )
          });
        } catch (error) {
          const refreshedQueue = await this.loadSponsorQueueFile();
          const finishedAtIso = new Date().toISOString();
          await this.saveSponsorQueueFile({
            jobs: refreshedQueue.jobs.map((job) =>
              job.jobId === nextJob.jobId
                ? {
                    ...runningJob,
                    status: "failed",
                    finishedAtIso,
                    lastError: error instanceof Error ? error.message : "Unknown sponsor queue error."
                  }
                : job
            )
          });
        }
      }
    })().finally(() => {
      this.sponsorQueueRunPromise = null;
    });

    return this.sponsorQueueRunPromise;
  }

  private buildLiveFlowTargets(events: ClawzEvent[], liveFlow: LiveSessionTurnFlowState): LiveFlowTargets {
    const turnTargets = new Map<string, MutableLiveFlowTurnTarget>();
    const disclosureTargets = new Map<string, LiveFlowDisclosureTarget>();
    const sortedEvents = [...events].sort((left, right) => left.occurredAtIso.localeCompare(right.occurredAtIso));

    const ensureTurnTarget = (sessionId: string, turnId: string, latestEventType = "SessionCreated") => {
      const key = `${sessionId}:${turnId}`;
      const existing = turnTargets.get(key);
      if (existing) {
        return existing;
      }

      const next: MutableLiveFlowTurnTarget = {
        sessionId,
        turnId,
        latestEventType,
        canStartNextTurn: false,
        canAbort: false,
        canRefund: true,
        canRevokeDisclosure: false,
        finalized: false,
        aborted: false,
        leased: false,
        started: false
      };
      turnTargets.set(key, next);
      return next;
    };

    sortedEvents.forEach((event) => {
      const payload = event.payload as Record<string, unknown>;
      const sessionId = asString(payload.sessionId);
      const turnId = asString(payload.turnId);
      const disclosureId = asString(payload.disclosureId);
      const turnTarget = sessionId && turnId ? ensureTurnTarget(sessionId, turnId, event.type) : undefined;

      if (turnTarget) {
        turnTarget.latestEventType = event.type;
        turnTarget.lastOccurredAtIso = event.occurredAtIso;

        if (event.type === "LeaseAcquired") {
          turnTarget.leased = true;
        }
        if (event.type === "TurnBegan") {
          turnTarget.started = true;
        }
        if (event.type === "TurnFinalized") {
          turnTarget.finalized = true;
        }
        if (event.type === "TurnAborted") {
          turnTarget.aborted = true;
        }
        if (event.type === "TurnSettled") {
          const spentMina = asString(payload.spentMina);
          const refundedMina = asString(payload.refundedMina);
          if (spentMina) {
            turnTarget.spentMina = spentMina;
          }
          if (refundedMina) {
            turnTarget.refundedMina = refundedMina;
          }
        }
      }

      if (event.type === "DisclosureGranted" && sessionId && turnId && disclosureId) {
        disclosureTargets.set(disclosureId, {
          disclosureId,
          sessionId,
          turnId,
          grantedAtIso: event.occurredAtIso,
          active: true
        });
      }

      if (event.type === "DisclosureRevoked" && sessionId && turnId && disclosureId) {
        const existing = disclosureTargets.get(disclosureId);
        disclosureTargets.set(disclosureId, {
          disclosureId,
          sessionId,
          turnId,
          ...(existing?.grantedAtIso ? { grantedAtIso: existing.grantedAtIso } : {}),
          revokedAtIso: event.occurredAtIso,
          active: false
        });
      }
    });

    if (liveFlow.status !== "idle" && liveFlow.sessionId && liveFlow.turnId) {
      const liveTarget = ensureTurnTarget(liveFlow.sessionId, liveFlow.turnId, liveFlow.flowKind ?? liveFlow.status);
      const latestLiveLabel = liveFlow.steps.at(-1)?.label;
      if (latestLiveLabel) {
        liveTarget.latestEventType = latestLiveLabel;
      }
      if (liveFlow.generatedAtIso) {
        liveTarget.lastOccurredAtIso = liveFlow.generatedAtIso;
      }
      liveTarget.leased = liveTarget.leased || liveFlow.completedStepLabels.includes("TurnKernel.acquireLease");
      liveTarget.started = liveTarget.started || liveFlow.completedStepLabels.includes("TurnKernel.beginTurn");
      liveTarget.finalized = liveTarget.finalized || liveFlow.completedStepLabels.includes("TurnKernel.finalizeTurn");
      liveTarget.aborted = liveTarget.aborted || liveFlow.completedStepLabels.includes("TurnKernel.abortTurn");
      if (liveFlow.steps.some((step) => step.label === "EscrowKernel.settleTurn")) {
        liveTarget.spentMina = liveTarget.spentMina ?? "tracked-on-chain";
      }
      if (liveFlow.steps.some((step) => step.label === "EscrowKernel.refundTurn")) {
        liveTarget.refundedMina = liveTarget.refundedMina ?? liveFlow.refundAmountMina ?? "tracked-on-chain";
      }

      const disclosedAtIso = liveFlow.steps.find((step) => step.label === "DisclosureKernel.grantDisclosure")?.occurredAtIso;
      const revokedAtIso = liveFlow.steps.find((step) => step.label === "DisclosureKernel.revokeDisclosure")?.occurredAtIso;
      const fallbackDisclosureId =
        liveFlow.sourceDisclosureId ??
        (liveFlow.jobId && liveFlow.steps.some((step) => step.label === "DisclosureKernel.grantDisclosure")
          ? `${liveFlow.turnId}:disclosure:${liveFlow.jobId}`
          : undefined);

      if (fallbackDisclosureId) {
        const existing = disclosureTargets.get(fallbackDisclosureId);
        disclosureTargets.set(fallbackDisclosureId, {
          disclosureId: fallbackDisclosureId,
          sessionId: liveFlow.sessionId,
          turnId: liveFlow.turnId,
          ...(existing?.grantedAtIso || disclosedAtIso
            ? { grantedAtIso: existing?.grantedAtIso ?? disclosedAtIso! }
            : {}),
          ...(revokedAtIso || existing?.revokedAtIso
            ? { revokedAtIso: revokedAtIso ?? existing?.revokedAtIso! }
            : {}),
          active: revokedAtIso ? false : (existing?.active ?? Boolean(disclosedAtIso))
        });
      }
    }

    const disclosures = [...disclosureTargets.values()].sort((left, right) =>
      (right.grantedAtIso ?? right.revokedAtIso ?? "").localeCompare(left.grantedAtIso ?? left.revokedAtIso ?? "")
    );

    const activeDisclosureByTurn = new Map<string, LiveFlowDisclosureTarget>();
    disclosures.forEach((disclosure) => {
      if (!disclosure.active) {
        return;
      }
      const key = `${disclosure.sessionId}:${disclosure.turnId}`;
      if (!activeDisclosureByTurn.has(key)) {
        activeDisclosureByTurn.set(key, disclosure);
      }
    });

    return {
      turns: [...turnTargets.values()]
        .map<LiveFlowTurnTarget>((target) => {
          const activeDisclosure = activeDisclosureByTurn.get(`${target.sessionId}:${target.turnId}`);
          return {
            sessionId: target.sessionId,
            turnId: target.turnId,
            latestEventType: target.latestEventType,
            ...(target.lastOccurredAtIso ? { lastOccurredAtIso: target.lastOccurredAtIso } : {}),
            ...(activeDisclosure?.disclosureId || target.latestDisclosureId
              ? { latestDisclosureId: activeDisclosure?.disclosureId ?? target.latestDisclosureId }
              : {}),
            ...(target.spentMina ? { spentMina: target.spentMina } : {}),
            ...(target.refundedMina ? { refundedMina: target.refundedMina } : {}),
            canStartNextTurn: target.finalized && !target.aborted,
            canAbort: !target.finalized && !target.aborted && (target.leased || target.started),
            canRefund: true,
            canRevokeDisclosure: Boolean(activeDisclosure)
          };
        })
        .sort((left, right) => (right.lastOccurredAtIso ?? "").localeCompare(left.lastOccurredAtIso ?? "")),
      disclosures
    };
  }

  private async loadLiveFlowExecutor(): Promise<LiveSessionTurnFlowModule> {
    const executorPath = path.join(this.workspaceRoot, "packages", "contracts", "dist", "contracts", "src", "index.js");
    const moduleUrl = pathToFileURL(executorPath).toString();
    return import(moduleUrl) as Promise<LiveSessionTurnFlowModule>;
  }

  private buildLiveFlowEvent(
    step: NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number],
    sessionId: string,
    turnId: string,
    trustModeId: TrustModeId
  ): ClawzEvent | undefined {
    if (typeof step.label !== "string" || typeof step.txHash !== "string" || typeof step.contractAddress !== "string") {
      return undefined;
    }

    const occurredAtIso = typeof step.occurredAtIso === "string" ? step.occurredAtIso : new Date().toISOString();
    const args = step.args ?? {};
    const handles = step.handles ?? {};
    const basePayload = {
      sessionId,
      turnId,
      txHash: step.txHash,
      contractAddress: step.contractAddress,
      changedSlots: Array.isArray(step.changedSlots) ? step.changedSlots : []
    };

    if (step.label === "SessionKernel.createSession") {
      return {
        id: `chain_${step.txHash}`,
        type: "SessionCreated",
        occurredAtIso,
        payload: {
          sessionId,
          trustMode: trustModeId,
          txHash: step.txHash,
          contractAddress: step.contractAddress,
          sessionIdHash: args.sessionIdHash,
          tenantIdHash: args.tenantIdHash
        }
      };
    }

    if (step.label === "SessionKernel.checkpointSession") {
      return {
        id: `chain_${step.txHash}`,
        type: "SessionCheckpointed",
        occurredAtIso,
        payload: {
          sessionId,
          turnId,
          txHash: step.txHash,
          contractAddress: step.contractAddress,
          checkpointId: handles.checkpointId,
          checkpointHash: args.checkpointHash
        }
      };
    }

    if (step.label === "TurnKernel.acquireLease") {
      return {
        id: `chain_${step.txHash}`,
        type: "LeaseAcquired",
        occurredAtIso,
        payload: {
          ...basePayload,
          leaseId: handles.leaseId,
          leaseIdHash: args.leaseIdHash,
          workerIdHash: args.workerIdHash
        }
      };
    }

    if (step.label === "ApprovalKernel.requestApproval") {
      return {
        id: `chain_${step.txHash}`,
        type: "ApprovalRequested",
        occurredAtIso,
        payload: {
          ...basePayload,
          approvalId: handles.approvalId,
          approvalIdHash: args.approvalIdHash,
          policyHash: args.policyHash
        }
      };
    }

    if (step.label === "ApprovalKernel.grantApproval") {
      return {
        id: `chain_${step.txHash}`,
        type: "ApprovalGranted",
        occurredAtIso,
        payload: {
          ...basePayload,
          requestLeaf: args.requestLeaf,
          observedApprovals: args.observedApprovals
        }
      };
    }

    if (step.label === "ApprovalKernel.requestPrivacyException") {
      return {
        id: `chain_${step.txHash}`,
        type: "PrivacyExceptionRequested",
        occurredAtIso,
        payload: {
          ...basePayload,
          exceptionId: handles.exceptionId,
          scopeHash: args.scopeHash,
          audienceHash: args.audienceHash
        }
      };
    }

    if (step.label === "EscrowKernel.reserveBudget") {
      return {
        id: `chain_${step.txHash}`,
        type: "BudgetReserved",
        occurredAtIso,
        payload: {
          ...basePayload,
          reservationId: handles.reservationId,
          reservedMina: fromNanomina(BigInt(args.reservedAmount ?? "0")),
          budgetEpoch: args.budgetEpoch
        }
      };
    }

    if (step.label === "TurnKernel.beginTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnBegan",
        occurredAtIso,
        payload: {
          ...basePayload,
          leaseIdHash: args.leaseIdHash
        }
      };
    }

    if (step.label === "TurnKernel.commitOutput") {
      return {
        id: `chain_${step.txHash}`,
        type: "OutputCommitted",
        occurredAtIso,
        payload: {
          ...basePayload,
          outputHash: args.outputHash,
          artifactRoot: args.artifactRoot,
          originProofRoot: args.originProofRoot
        }
      };
    }

    if (step.label === "TurnKernel.abortTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnAborted",
        occurredAtIso,
        payload: {
          ...basePayload,
          abortReason: handles.abortReason,
          abortReasonHash: args.abortReasonHash
        }
      };
    }

    if (step.label === "EscrowKernel.settleTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnSettled",
        occurredAtIso,
        payload: {
          ...basePayload,
          reservedMina: fromNanomina(BigInt(args.reservedAmount ?? "0")),
          spentMina: fromNanomina(BigInt(args.payoutAmount ?? "0")),
          refundedMina: fromNanomina(BigInt(args.refundedAmount ?? "0"))
        }
      };
    }

    if (step.label === "EscrowKernel.refundTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnRefunded",
        occurredAtIso,
        payload: {
          ...basePayload,
          refundId: handles.refundId,
          refundAmountMina: handles.refundAmountMina ?? fromNanomina(BigInt(args.refundAmount ?? "0"))
        }
      };
    }

    if (step.label === "TurnKernel.finalizeTurn") {
      return {
        id: `chain_${step.txHash}`,
        type: "TurnFinalized",
        occurredAtIso,
        payload: {
          ...basePayload,
          settlementHash: args.settlementHash
        }
      };
    }

    if (step.label === "DisclosureKernel.grantDisclosure") {
      return {
        id: `chain_${step.txHash}`,
        type: "DisclosureGranted",
        occurredAtIso,
        payload: {
          ...basePayload,
          disclosureId: handles.disclosureId,
          audienceHash: args.audienceHash,
          retentionHash: args.retentionHash
        }
      };
    }

    if (step.label === "DisclosureKernel.revokeDisclosure") {
      return {
        id: `chain_${step.txHash}`,
        type: "DisclosureRevoked",
        occurredAtIso,
        payload: {
          ...basePayload,
          disclosureId: handles.disclosureId,
          revocationReason: handles.revocationReason
        }
      };
    }

    return undefined;
  }

  private async recordLiveFlowStep(
    step: NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number],
    sessionId: string,
    turnId: string,
    trustModeId: TrustModeId
  ) {
    const event = this.buildLiveFlowEvent(step, sessionId, turnId, trustModeId);
    if (!event) {
      return;
    }

    try {
      await this.ingestEvent(event);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Event already exists:")) {
        return;
      }
      throw error;
    }
  }

  async runLiveSessionTurnFlow(options: LiveFlowRunOptions = {}): Promise<ConsoleStateResponse> {
    if (this.liveFlowRunPromise) {
      return this.liveFlowRunPromise;
    }

    this.liveFlowRunPromise = (async () => {
      const flowKind = options.flowKind ?? "first-turn";
      const state = await this.loadState();
      const events = await this.loadEvents();
      const requestedAtIso = new Date().toISOString();
      const privacyExceptions = this.normalizePrivacyExceptions(state, requestedAtIso);
      const existingStatus = await this.loadLiveFlowStatus();
      const liveFlowState = await this.getLiveFlowState();
      const resume = this.canResumeLiveFlow(existingStatus, options);
      const jobTrustModeId =
        resume && existingStatus?.trustModeId
          ? existingStatus.trustModeId
          : flowKind === "first-turn"
            ? state.activeMode
            : this.resolveSessionTrustMode(
                events,
                options.sessionId ?? liveFlowState.sessionId ?? state.currentSessionId,
                state.activeMode
              );
      const job = resume && existingStatus
        ? {
            ...existingStatus,
            flowKind,
            trustModeId: existingStatus.trustModeId ?? jobTrustModeId,
            status: "queued" as const,
            requestedAtIso: existingStatus.requestedAtIso ?? requestedAtIso,
            completedStepLabels: existingStatus.completedStepLabels ?? [],
            totalSteps: existingStatus.totalSteps ?? this.flowMethodsFor(flowKind).length,
            attemptCount: (existingStatus.attemptCount ?? 0) + 1,
            resumeAvailable: false,
            witnessPlanPath: existingStatus.witnessPlanPath ?? this.liveFlowPlanPath,
            reportPath: existingStatus.reportPath ?? this.liveFlowReportPath
          }
        : this.buildLiveFlowJob(state, requestedAtIso, { ...options, flowKind }, liveFlowState, jobTrustModeId);
      await this.saveLiveFlowStatus(job);
      const startedAtIso = new Date().toISOString();
      const queuedNextStep = this.nextLiveFlowLabel(flowKind, job.completedStepLabels ?? []);
      const runningStatus: LiveSessionTurnFlowStatusFile = {
        ...job,
        status: "running",
        lastStartedAtIso: startedAtIso,
        resumeAvailable: false,
        ...(queuedNextStep ? { currentStepLabel: queuedNextStep } : {})
      };

      await this.saveLiveFlowStatus(runningStatus);

      try {
        const executor = await this.loadLiveFlowExecutor();
        const executeOptions = {
          workspaceRoot: this.workspaceRoot,
          witnessPlanPath: runningStatus.witnessPlanPath ?? this.liveFlowPlanPath,
          reportPath: runningStatus.reportPath ?? this.liveFlowReportPath,
          ...(runningStatus.sessionId ? { sessionId: runningStatus.sessionId } : {}),
          ...(runningStatus.turnId ? { turnId: runningStatus.turnId } : {}),
          ...(resume
            ? { resume: true }
            : {
                runtimeInput: this.buildRuntimeLiveFlowInput(state, privacyExceptions, runningStatus)
              }),
          onStep: async (step: NonNullable<LiveSessionTurnFlowReportFile["steps"]>[number]) => {
            const completedStepLabels = [
              ...(runningStatus.completedStepLabels ?? []),
              ...(typeof step.label === "string" ? [step.label] : [])
            ].filter((label, index, labels) => labels.indexOf(label) === index);
            const nextStepLabel = this.nextLiveFlowLabel(flowKind, completedStepLabels);
            const { currentStepLabel: _currentStepLabel, ...runningStatusBase } = runningStatus;

            runningStatus.completedStepLabels = completedStepLabels;

            await this.saveLiveFlowStatus({
              ...runningStatusBase,
              status: "running",
              completedStepLabels,
              totalSteps: this.flowMethodsFor(flowKind).length,
              ...(nextStepLabel ? { currentStepLabel: nextStepLabel } : {}),
              ...(runningStatus.witnessPlanPath ? { witnessPlanPath: runningStatus.witnessPlanPath } : {}),
              ...(runningStatus.reportPath ? { reportPath: runningStatus.reportPath } : {})
            });
            await this.recordLiveFlowStep(
              step,
              runningStatus.sessionId ?? state.currentSessionId,
              runningStatus.turnId ?? DEFAULT_TURN_ID,
              runningStatus.trustModeId ?? state.activeMode
            );
          }
        };
        const report = await executor.executeLiveSessionTurnFlow(executeOptions);
        const completedStepLabels = (report.steps ?? [])
          .map((step) => step.label ?? "")
          .filter((label): label is string => label.length > 0);
        const { currentStepLabel: _currentStepLabel, ...runningStatusBase } = runningStatus;

        await this.saveLiveFlowStatus({
          ...runningStatusBase,
          status: "succeeded",
          completedStepLabels,
          totalSteps: this.flowMethodsFor(flowKind).length,
          lastStartedAtIso: startedAtIso,
          lastFinishedAtIso: report.generatedAtIso ?? new Date().toISOString(),
          resumeAvailable: false,
          ...(runningStatus.witnessPlanPath ? { witnessPlanPath: runningStatus.witnessPlanPath } : {}),
          ...(runningStatus.reportPath ? { reportPath: runningStatus.reportPath } : {})
        });

        const refreshedState = await this.loadState();
        const focusedState = this.applyFocusedSession(
          refreshedState,
          runningStatus.sessionId ?? refreshedState.currentSessionId,
          runningStatus.trustModeId ?? refreshedState.activeMode
        );
        await this.saveState(focusedState);

        return this.getConsoleState();
      } catch (error) {
        const partialReport = await this.loadLiveFlowReport();
        const completedStepLabels = (partialReport?.steps ?? [])
          .map((step) => step.label ?? "")
          .filter((label): label is string => label.length > 0);
        const nextStepLabel = this.nextLiveFlowLabel(flowKind, completedStepLabels);
        const { currentStepLabel: _currentStepLabel, ...runningStatusBase } = runningStatus;

        await this.saveLiveFlowStatus({
          ...runningStatusBase,
          status: "failed",
          completedStepLabels,
          totalSteps: this.flowMethodsFor(flowKind).length,
          lastStartedAtIso: startedAtIso,
          lastFinishedAtIso: new Date().toISOString(),
          resumeAvailable: completedStepLabels.length < this.flowMethodsFor(flowKind).length,
          lastError: error instanceof Error ? error.message : "Unknown live flow error.",
          ...(nextStepLabel ? { currentStepLabel: nextStepLabel } : {}),
          ...(runningStatus.witnessPlanPath ? { witnessPlanPath: runningStatus.witnessPlanPath } : {}),
          ...(runningStatus.reportPath ? { reportPath: runningStatus.reportPath } : {})
        });
        throw error;
      } finally {
        this.liveFlowRunPromise = null;
      }
    })();

    return this.liveFlowRunPromise;
  }

  private async reconcileStateFromEvent(state: ConsolePersistenceState, event: ClawzEvent): Promise<ConsolePersistenceState> {
    const payload = event.payload as Record<string, unknown>;

    if (event.type === "SessionCreated" && typeof payload.sessionId === "string") {
      const maybeMode = typeof payload.trustMode === "string" && isTrustModeId(payload.trustMode) ? payload.trustMode : state.activeMode;
      return this.applyFocusedSession(state, payload.sessionId, maybeMode);
    }

    if (event.type === "PrivacyExceptionRequested" && typeof payload.exceptionId === "string") {
      const alreadyExists = state.privacyExceptions.some((item) => item.id === payload.exceptionId);
      if (alreadyExists) {
        return state;
      }

      const nextException: PrivacyExceptionQueueItem = {
        id: payload.exceptionId,
        sessionId: typeof payload.sessionId === "string" ? payload.sessionId : state.currentSessionId,
        turnId: typeof payload.turnId === "string" ? payload.turnId : DEFAULT_TURN_ID,
        title: typeof payload.title === "string" ? payload.title : "Requested privacy exception",
        audience: typeof payload.audience === "string" ? payload.audience : "Compliance reviewer",
        duration: typeof payload.duration === "string" ? payload.duration : "24h",
        scope: typeof payload.scope === "string" ? payload.scope : typeof payload.summary === "string" ? payload.summary : "Scoped artifact disclosure",
        reason: typeof payload.reason === "string" ? payload.reason : "Imported from event stream.",
        severity: typeof payload.severity === "string" && (payload.severity === "low" || payload.severity === "medium" || payload.severity === "high") ? payload.severity : "medium",
        status: "pending",
        requiredApprovals: state.wallet.governancePolicy.requiredApprovals,
        approvals: [],
        expiresAtIso: typeof payload.expiresAtIso === "string" ? payload.expiresAtIso : plusHours(event.occurredAtIso, state.wallet.governancePolicy.autoExpiryHours)
      };

      return {
        ...state,
        privacyExceptions: [nextException, ...state.privacyExceptions]
      };
    }

    if (event.type === "CreditsDeposited" && typeof payload.amountMina === "string") {
      const amountMina = payload.amountMina;
      return {
        ...state,
        wallet: {
          ...state.wallet,
          sponsoredBudgetMina: addMina(state.wallet.sponsoredBudgetMina, amountMina),
          sponsoredRemainingMina: addMina(state.wallet.sponsoredRemainingMina, amountMina)
        }
      };
    }

    if (event.type === "TurnSettled" && typeof payload.spentMina === "string") {
      return {
        ...state,
        wallet: {
          ...state.wallet,
          sponsoredRemainingMina: subtractMina(state.wallet.sponsoredRemainingMina, payload.spentMina)
        }
      };
    }

    if (event.type === "TurnRefunded" && typeof payload.refundAmountMina === "string") {
      return {
        ...state,
        wallet: {
          ...state.wallet,
          sponsoredRemainingMina: addMina(state.wallet.sponsoredRemainingMina, payload.refundAmountMina)
        }
      };
    }

    return state;
  }

  async getConsoleState(options: ConsoleStateOptions = {}): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const normalizedExceptions = this.normalizePrivacyExceptions(state);
    const [manifests, deployment, liveFlow, sponsorQueueFile] = await Promise.all([
      this.blobStore.listManifests(state.currentSessionId),
      this.getDeploymentState(),
      this.getLiveFlowState(),
      this.loadSponsorQueueFile()
    ]);
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const requestedSessionId =
      options.sessionId ??
      (options.agentId ? this.resolveSessionIdFromAgentId(state, options.agentId) : undefined);
    if (options.agentId && !requestedSessionId) {
      throw new Error(`Unknown agent: ${options.agentId}`);
    }
    const focus = this.resolveSessionFocus(state, events, liveFlowTargets, liveFlow, requestedSessionId);
    const materializer = new ReplayMaterializer(events);
    const session = materializer.getSession(focus.sessionId);
    const sessionManifests = focus.sessionId === state.currentSessionId ? manifests : await this.blobStore.listManifests(focus.sessionId);
    const sessionExceptions = normalizedExceptions
      .filter((item) => item.sessionId === focus.sessionId)
      .sort((left, right) => left.status.localeCompare(right.status) || right.severity.localeCompare(left.severity));
    const sessionTimeMachine = new ReplayMaterializer(session.events).buildTimeMachineEntries().slice(0, 12);
    const sponsorQueue = this.buildSponsorQueueState(sponsorQueueFile, focus.sessionId);
    const profile = this.profileForSession(state, focus.sessionId, focus.trustModeId);
    const agentId = this.agentIdForSession(state, focus.sessionId, focus.trustModeId);
    const published = liveFlowTargets.turns.some((target) => target.sessionId === focus.sessionId);
    const paymentsEnabled = profile.paymentProfile.enabled;
    const paymentProfileReady = hasReadyPaymentProfile(profile);
    const payoutAddressConfigured = hasPayoutAddress(profile);
    const paidJobsEnabled = computePaidJobsEnabled(profile, published, deployment);

    return {
      agentId,
      paymentsEnabled,
      paymentProfileReady,
      payoutAddressConfigured,
      paidJobsEnabled,
      wallet: {
        ...state.wallet,
        trustModeId: focus.trustModeId
      },
      trustModes: TRUST_MODE_PRESETS,
      ghostRun: buildGhostRunPlan(focus.trustModeId),
      privacyExceptions: sessionExceptions,
      timeMachine: sessionTimeMachine,
      session: {
        sessionId: focus.sessionId,
        eventCount: session.events.length,
        turnCount: session.turns.length,
        privacyExceptionCount: sessionExceptions.length,
        sealedArtifactCount: sessionManifests.length,
        focusSource: focus.focusSource,
        knownSessionIds: focus.knownSessionIds,
        ...(session.events.at(-1)?.occurredAtIso ? { lastEventAtIso: session.events.at(-1)!.occurredAtIso } : {})
      },
      artifacts: sessionManifests.map<ArtifactSummary>((manifest) => ({
        manifestId: manifest.manifestId,
        artifactClass: manifest.artifactClass,
        visibility: manifest.visibility,
        createdAtIso: manifest.createdAtIso,
        payloadDigest: manifest.payloadDigest
      })),
      deployment,
      liveFlowTargets,
      liveFlow,
      sponsorQueue,
      profile
    };
  }

  async listRegisteredAgents(): Promise<AgentRegistryEntry[]> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const [liveFlow, deployment] = await Promise.all([this.getLiveFlowState(), this.getDeploymentState()]);
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const materializer = new ReplayMaterializer(events);
    const proofRank = (proofLevel: AgentRegistryEntry["proofLevel"]) =>
      proofLevel === "proof-backed" ? 3 : proofLevel === "rooted" ? 2 : 1;

    return this.buildKnownSessionIds(state, events)
      .map((sessionId) => {
        const trustModeId = this.resolveSessionTrustMode(events, sessionId, state.activeMode);
        const trustMode = TRUST_MODE_PRESETS.find((mode) => mode.id === trustModeId) ?? TRUST_MODE_PRESETS[0]!;
        const profile = this.profileForSession(state, sessionId, trustModeId);
        const session = materializer.getSession(sessionId);
        const published = liveFlowTargets.turns.some((target) => target.sessionId === sessionId);
        const lastUpdatedAtIso = session.events.at(-1)?.occurredAtIso;
        return {
          agentId: this.agentIdForSession(state, sessionId, trustModeId),
          sessionId,
          networkId: deployment.networkId,
          agentName: profile.agentName,
          representedPrincipal: profile.representedPrincipal,
          headline: profile.headline,
          openClawUrl: profile.openClawUrl,
          trustModeId,
          trustModeLabel: trustMode.label,
          proofLevel: trustMode.proofLevel,
          preferredProvingLocation: profile.preferredProvingLocation,
          paymentsEnabled: profile.paymentProfile.enabled,
          ...(profile.paymentProfile.defaultRail ? { paymentRail: profile.paymentProfile.defaultRail } : {}),
          pricingMode: profile.paymentProfile.pricingMode,
          settlementTrigger: profile.paymentProfile.settlementTrigger,
          payoutAddressConfigured: hasPayoutAddress(profile),
          paymentProfileReady: hasReadyPaymentProfile(profile),
          paidJobsEnabled: computePaidJobsEnabled(profile, published, deployment),
          published,
          ...(lastUpdatedAtIso ? { lastUpdatedAtIso } : {})
        } satisfies AgentRegistryEntry;
      })
      .filter((entry) => entry.openClawUrl.trim().length > 0 && entry.agentName.trim().length > 0 && entry.headline.trim().length > 0)
      .sort((left, right) => {
        if (left.published !== right.published) {
          return Number(right.published) - Number(left.published);
        }
        const byProof = proofRank(right.proofLevel) - proofRank(left.proofLevel);
        if (byProof !== 0) {
          return byProof;
        }
        const byUpdated = (right.lastUpdatedAtIso ?? "").localeCompare(left.lastUpdatedAtIso ?? "");
        if (byUpdated !== 0) {
          return byUpdated;
        }
        return left.agentName.localeCompare(right.agentName);
      });
  }

  async listEvents(options: EventListOptions = {}): Promise<ClawzEvent[]> {
    return this.filterEvents(await this.loadEvents(), options);
  }

  async getSession(sessionId: string) {
    return new ReplayMaterializer(await this.loadEvents()).getSession(sessionId);
  }

  async getTurnReplay(turnId: string) {
    return new ReplayMaterializer(await this.loadEvents()).getTurnReplay(turnId);
  }

  async listPrivacyExceptions(sessionId?: string): Promise<PrivacyExceptionQueueItem[]> {
    const state = await this.loadState();
    const items = this.normalizePrivacyExceptions(state);
    return sessionId ? items.filter((item) => item.sessionId === sessionId) : items;
  }

  async listSponsorQueue(sessionId?: string): Promise<SponsorQueueState> {
    return this.getSponsorQueueState(sessionId);
  }

  async registerAgent(options: RegisterAgentOptions): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const registeredAtIso = new Date().toISOString();
    const trustModeId = options.trustModeId ?? "private";
    const sessionSlug = randomUUID().replace(/-/g, "").slice(0, 12);
    const sessionId = `session_agent_${sessionSlug}`;
    const fallbackProfile = buildDefaultProfile(trustModeId);
    const profile = this.sanitizeProfileInput(
      trustModeId,
      {
        agentName: options.agentName,
        headline: options.headline,
        openClawUrl: options.openClawUrl,
        ...(options.payoutWallets ? { payoutWallets: options.payoutWallets } : {}),
        ...(options.paymentProfile ? { paymentProfile: options.paymentProfile } : {}),
        ...(options.payoutAddress ? { payoutAddress: options.payoutAddress } : {}),
        ...(options.representedPrincipal ? { representedPrincipal: options.representedPrincipal } : {}),
        ...(options.preferredProvingLocation ? { preferredProvingLocation: options.preferredProvingLocation } : {})
      },
      fallbackProfile
    );

    if (profile.agentName.trim().length === 0 || profile.headline.trim().length === 0 || profile.openClawUrl.trim().length === 0) {
      throw new Error("agentName, headline, and openClawUrl are required.");
    }

    const agentId = buildStableAgentId(profile.agentName, sessionId);
    const nextState: ConsolePersistenceState = {
      ...this.applyFocusedSession(state, sessionId, trustModeId),
      agentIdsBySession: {
        ...state.agentIdsBySession,
        [sessionId]: agentId
      },
      profilesBySession: {
        ...state.profilesBySession,
        [sessionId]: profile
      }
    };

    await this.saveState(nextState);
    await this.appendEvent(
      "SessionCreated",
      {
        sessionId,
        tenantId: DEFAULT_TENANT_ID,
        trustMode: trustModeId,
        registrationSource: "self-serve",
        representedPrincipal: profile.representedPrincipal
      },
      registeredAtIso
    );
    await this.appendEvent(
      "SessionCheckpointed",
      {
        sessionId,
        agentId,
        registeredAgent: true
      },
      registeredAtIso
    );

    return this.getConsoleState({ sessionId });
  }

  async submitHireRequest(options: SubmitHireRequestOptions): Promise<HireRequestReceipt> {
    const state = await this.loadState();
    const sessionId = this.resolveSessionIdFromAgentId(state, options.agentId);
    if (!sessionId) {
      throw new Error(`Unknown agent: ${options.agentId}`);
    }

    const [events, liveFlow, deployment, hireRequests] = await Promise.all([
      this.loadEvents(),
      this.getLiveFlowState(),
      this.getDeploymentState(),
      this.loadHireRequestFile()
    ]);
    const liveFlowTargets = this.buildLiveFlowTargets(events, liveFlow);
    const trustModeId = this.resolveSessionTrustMode(events, sessionId, state.activeMode);
    const profile = this.profileForSession(state, sessionId, trustModeId);
    const published = liveFlowTargets.turns.some((target) => target.sessionId === sessionId);
    if (!published) {
      throw new Error("This agent needs to publish on Zeko before it can accept hire requests.");
    }
    if (!profile.openClawUrl.trim()) {
      throw new Error("This agent has no OpenClaw callback URL configured yet.");
    }
    if (options.taskPrompt.trim().length === 0 || options.requesterContact.trim().length === 0) {
      throw new Error("taskPrompt and requesterContact are required.");
    }
    const paidJobsEnabled = computePaidJobsEnabled(profile, published, deployment);

    const submittedAtIso = new Date().toISOString();
    const requestId = `hire_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const nextRecord: HireRequestRecord = {
      requestId,
      agentId: options.agentId,
      sessionId,
      networkId: deployment.networkId,
      submittedAtIso,
      status: "submitted",
      taskPrompt: options.taskPrompt.trim().slice(0, 2000),
      ...(typeof options.budgetMina === "string" && options.budgetMina.trim().length > 0
        ? { budgetMina: options.budgetMina.trim().slice(0, 40) }
        : {}),
      requesterContact: options.requesterContact.trim().slice(0, 240),
      deliveryTarget: profile.openClawUrl
    };

    await this.saveHireRequestFile({
      requests: [nextRecord, ...hireRequests.requests].slice(0, 200)
    });

    return {
      requestId,
      agentId: options.agentId,
      sessionId,
      networkId: deployment.networkId,
      submittedAtIso,
      status: "submitted",
      deliveryTarget: profile.openClawUrl,
      paidJobsEnabled
    };
  }

  async setTrustMode(modeId: TrustModeId, sessionId?: string): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const liveFlow = await this.getLiveFlowState();
    const focus = this.resolveSessionFocus(state, events, this.buildLiveFlowTargets(events, liveFlow), liveFlow, sessionId);
    const baseState = this.applyFocusedSession(state, focus.sessionId, modeId);
    const fallbackProfile = buildDefaultProfile(modeId);
    const currentProfile = this.profileForSession(state, focus.sessionId, modeId);
    const nextState: ConsolePersistenceState = {
      ...baseState,
      profilesBySession: {
        ...baseState.profilesBySession,
        [focus.sessionId]: this.sanitizeProfileInput(modeId, currentProfile, {
          ...fallbackProfile,
          ...currentProfile
        })
      }
    };
    await this.saveState(nextState);
    await this.appendEvent("SessionCheckpointed", {
      sessionId: focus.sessionId,
      trustMode: modeId
    });
    return this.getConsoleState({ sessionId: focus.sessionId });
  }

  async updateAgentProfile(sessionId: string | undefined, input: AgentProfileInput): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const liveFlow = await this.getLiveFlowState();
    const focus = this.resolveSessionFocus(state, events, this.buildLiveFlowTargets(events, liveFlow), liveFlow, sessionId);
    const trustModeId = focus.trustModeId;
    const fallbackProfile = buildDefaultProfile(trustModeId);
    const currentProfile = this.profileForSession(state, focus.sessionId, trustModeId);
    const nextProfile = this.sanitizeProfileInput(trustModeId, input, {
      ...fallbackProfile,
      ...currentProfile
    });
    const nextState: ConsolePersistenceState = {
      ...this.applyFocusedSession(state, focus.sessionId, trustModeId),
      profilesBySession: {
        ...state.profilesBySession,
        [focus.sessionId]: nextProfile
      }
    };
    await this.saveState(nextState);
    await this.appendEvent("SessionCheckpointed", {
      sessionId: focus.sessionId,
      profileUpdated: true
    });
    return this.getConsoleState({ sessionId: focus.sessionId });
  }

  async sponsorWallet(options: SponsorWalletOptions = {}): Promise<ConsoleStateResponse> {
    const amountMina = options.amountMina ?? "0.10";
    const requestedPurpose = options.purpose ?? "top-up";
    const explicitSponsorRequest = options.amountMina !== undefined || requestedPurpose === "top-up";
    const state = await this.loadState();
    const events = await this.loadEvents();
    const liveFlow = await this.getLiveFlowState();
    const focus = this.resolveSessionFocus(
      state,
      events,
      this.buildLiveFlowTargets(events, liveFlow),
      liveFlow,
      options.sessionId
    );
    const queue = await this.loadSponsorQueueFile();
    const existingPendingJob = queue.jobs.find(
      (job) => job.sessionId === focus.sessionId && (job.status === "queued" || job.status === "running")
    );
    if (existingPendingJob) {
      throw new Error("Sponsor queue already has a pending job for this agent.");
    }

    const remainingBudget = Number.parseFloat(state.wallet.sponsoredRemainingMina || "0");
    if (Number.isFinite(remainingBudget) && remainingBudget >= 0.2 && !explicitSponsorRequest) {
      throw new Error("Shadow wallet already has enough sponsored balance for the next publish.");
    }

    const slug = randomUUID().replace(/-/g, "").slice(0, 12);
    const requestedAtIso = new Date().toISOString();
    const nextJob: SponsorQueueJob = {
      jobId: `sponsor_${slug}`,
      sessionId: focus.sessionId,
      amountMina,
      purpose: requestedPurpose,
      status: "queued",
      requestedAtIso,
      note: "Queued for SantaClawz sponsor processing."
    };

    await this.saveSponsorQueueFile({
      jobs: [...queue.jobs, nextJob]
    });
    void this.runSponsorQueue();

    return this.getConsoleState({ sessionId: focus.sessionId });
  }

  async prepareRecoveryKit(sessionId?: string): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const events = await this.loadEvents();
    const liveFlow = await this.getLiveFlowState();
    const focus = this.resolveSessionFocus(state, events, this.buildLiveFlowTargets(events, liveFlow), liveFlow, sessionId);
    const preparedAtIso = new Date().toISOString();
    const manifest = await this.blobStore.sealJson({
      scope: {
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        sessionId: focus.sessionId
      },
      visibility: "team-sealed",
      retentionPolicy: sampleRetentionPolicy,
      sessionId: focus.sessionId,
      artifactClass: "recovery-kit",
      payload: {
        recoveryId: `recovery_${randomUUID()}`,
        walletId: state.wallet.walletId,
        guardians: state.wallet.guardians,
        threshold: state.wallet.recovery.guardiansRequired,
        preparedAtIso
      }
    });

    const nextState: ConsolePersistenceState = {
      ...this.applyFocusedSession(state, focus.sessionId, focus.trustModeId),
      wallet: {
        ...state.wallet,
        trustModeId: focus.trustModeId,
        deviceStatus: "recoverable",
        recovery: {
          ...state.wallet.recovery,
          status: "sealed",
          bundleManifestId: manifest.manifestId,
          sealedAtIso: preparedAtIso,
          lastRotationAtIso: preparedAtIso
        }
      }
    };

    await this.saveState(nextState);
    await this.appendEvent("SessionKeysRotated", {
      sessionId: focus.sessionId,
      bundleManifestId: manifest.manifestId,
      reason: "recovery-kit-prepared"
    }, preparedAtIso);
    await this.appendEvent("ArtifactSealed", {
      sessionId: focus.sessionId,
      manifestId: manifest.manifestId,
      artifactClass: manifest.artifactClass,
      payloadDigest: manifest.payloadDigest,
      visibility: manifest.visibility
    }, preparedAtIso);
    return this.getConsoleState({ sessionId: focus.sessionId });
  }

  async approvePrivacyException(
    exceptionId: string,
    actorId = "guardian_compliance",
    actorRole: PrivacyApprovalRecord["actorRole"] | undefined = "compliance-reviewer",
    note = "Approved for scoped disclosure.",
    sessionId?: string
  ): Promise<ConsoleStateResponse> {
    const state = await this.loadState();
    const nowIso = new Date().toISOString();
    const nextExceptions = state.privacyExceptions.map((item) => {
      if (item.id !== exceptionId || item.status === "expired") {
        return item;
      }

      const alreadyApproved = item.approvals.some((approval) => approval.actorId === actorId);
      const approvals = alreadyApproved
        ? item.approvals
        : [...item.approvals, buildPrivacyApproval(actorId, actorRole ?? "compliance-reviewer", note, nowIso)];
      return {
        ...item,
        approvals,
        status: approvals.length >= item.requiredApprovals ? "approved" as const : item.status
      };
    });

    const target = nextExceptions.find((item) => item.id === exceptionId);
    if (!target) {
      throw new Error(`Unknown privacy exception: ${exceptionId}`);
    }

    const nextState = {
      ...state,
      privacyExceptions: nextExceptions
    };

    await this.saveState(nextState);
    await this.appendEvent("ApprovalGranted", {
      sessionId: target.sessionId,
      turnId: target.turnId,
      exceptionId,
      actorId,
      actorRole,
      note
    }, nowIso);

    if (target.status === "approved") {
      await this.appendEvent("PrivacyExceptionGranted", {
        sessionId: target.sessionId,
        turnId: target.turnId,
        exceptionId,
        audience: target.audience,
        approvals: target.approvals.length
      }, nowIso);
    }

    return this.getConsoleState({ sessionId: sessionId ?? target.sessionId });
  }

  async ingestEvent(input: unknown): Promise<ClawzEvent> {
    const event = assertClawzEvent(input);
    const events = await this.loadEvents();
    if (events.some((existing) => existing.id === event.id)) {
      throw new Error(`Event already exists: ${event.id}`);
    }

    events.push(event);
    await this.saveEvents(events);

    const state = await this.loadState();
    const nextState = await this.reconcileStateFromEvent(state, event);
    await this.saveState(nextState);
    return event;
  }
}
