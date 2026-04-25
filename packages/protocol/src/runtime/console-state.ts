import type { ArtifactVisibility, PrivacyPreset, PrivacyProvingLocation } from "../privacy/types.js";

export type TrustModeId = "fast" | "private" | "verified" | "team-governed";

export interface TrustModeCard {
  id: TrustModeId;
  label: string;
  blurb: string;
  preset: PrivacyPreset;
  operatorVisible: boolean;
  providerVisible: boolean;
  proofLevel: "signed" | "rooted" | "proof-backed";
  maxSpendMina: string;
  retention: string;
  defaultArtifactVisibility: ArtifactVisibility;
  defaultProvingLocation: PrivacyProvingLocation;
  supportedProvingLocations: PrivacyProvingLocation[];
  stripe: string[];
}

export interface GhostStep {
  id: string;
  summary: string;
  capabilityClass: string;
  externalHost?: string;
  requiresApproval: boolean;
  expandsVisibility: boolean;
}

export interface GhostRunPlan {
  mode: TrustModeId;
  estimatedSpendMina: string;
  steps: GhostStep[];
  visibilitySummary: string[];
  privacyExceptionsRequired: boolean;
}

export interface GuardianRecord {
  guardianId: string;
  label: string;
  role: "security" | "legal" | "compliance" | "admin";
  status: "active" | "invited";
}

export interface RecoveryKitState {
  status: "not-prepared" | "sealed" | "rotating";
  guardiansRequired: number;
  bundleManifestId?: string;
  sealedAtIso?: string;
  lastRotationAtIso?: string;
}

export interface GovernancePolicy {
  requiredApprovals: number;
  reviewAudience: string;
  autoExpiryHours: number;
}

export interface ShadowWalletState {
  walletId: string;
  publicKey: string;
  deviceStatus: "device-bound" | "recoverable" | "rotating";
  sponsorStatus: "active" | "paused";
  sponsoredBudgetMina: string;
  sponsoredRemainingMina: string;
  trustModeId: TrustModeId;
  guardians: GuardianRecord[];
  recovery: RecoveryKitState;
  governancePolicy: GovernancePolicy;
}

export interface PrivacyApprovalRecord {
  actorId: string;
  actorRole: "operator" | "tenant-admin" | "compliance-reviewer" | "workspace-member";
  approvedAtIso: string;
  note: string;
}

export interface PrivacyExceptionQueueItem {
  id: string;
  sessionId: string;
  turnId: string;
  title: string;
  audience: string;
  duration: string;
  scope: string;
  reason: string;
  severity: "low" | "medium" | "high";
  status: "pending" | "approved" | "expired";
  requiredApprovals: number;
  approvals: PrivacyApprovalRecord[];
  expiresAtIso: string;
}

export interface TimeMachineEntry {
  id: string;
  label: string;
  outcome: string;
  note: string;
  occurredAtIso: string;
}

export interface SessionSummary {
  sessionId: string;
  eventCount: number;
  turnCount: number;
  privacyExceptionCount: number;
  sealedArtifactCount: number;
  focusSource?: "requested" | "live-flow" | "latest-indexed" | "stored-default";
  knownSessionIds?: string[];
  lastEventAtIso?: string;
}

export interface ArtifactSummary {
  manifestId: string;
  artifactClass: string;
  visibility: ArtifactVisibility;
  createdAtIso: string;
  payloadDigest: string;
}

export type ZekoDeploymentMode = "local-runtime" | "planned-testnet" | "testnet-live";

export interface ZekoContractDeployment {
  label: string;
  status: "deployed" | "skipped" | "unavailable";
  address?: string;
  txHash?: string;
  fundedNewAccount?: boolean;
  secretSource?: "env" | "keychain";
}

export interface ZekoWitnessPlanSummary {
  scenarioId?: string;
  preparedContractCalls: number;
  preparedProofCalls: number;
  liveFlowMethods: string[];
}

export interface ZekoDeploymentState {
  chain: "zeko";
  networkId: string;
  mode: ZekoDeploymentMode;
  graphqlEndpoint: string;
  archiveEndpoint: string;
  deployerPublicKey?: string;
  generatedAtIso?: string;
  contracts: ZekoContractDeployment[];
  witnessPlan: ZekoWitnessPlanSummary;
  privacyGrade: "pilot-grade" | "production-grade";
  keyManagement: "durable-local-file-backed" | "external-kms-backed" | "in-memory-default-export";
  privacyNote: string;
}

export interface LiveSessionTurnFlowStep {
  label: string;
  contractAddress: string;
  txHash: string;
  changedSlots: number[];
  occurredAtIso?: string;
}

export interface LiveFlowTurnTarget {
  sessionId: string;
  turnId: string;
  latestEventType: string;
  lastOccurredAtIso?: string;
  latestDisclosureId?: string;
  spentMina?: string;
  refundedMina?: string;
  canStartNextTurn: boolean;
  canAbort: boolean;
  canRefund: boolean;
  canRevokeDisclosure: boolean;
}

export interface LiveFlowDisclosureTarget {
  disclosureId: string;
  sessionId: string;
  turnId: string;
  grantedAtIso?: string;
  revokedAtIso?: string;
  active: boolean;
}

export interface LiveFlowTargets {
  turns: LiveFlowTurnTarget[];
  disclosures: LiveFlowDisclosureTarget[];
}

export interface LiveSessionTurnFlowState {
  flowKind?: "first-turn" | "next-turn" | "abort-turn" | "refund-turn" | "revoke-disclosure";
  scenarioId: string;
  sessionId: string;
  turnId: string;
  sourceTurnId?: string;
  sourceDisclosureId?: string;
  abortReason?: string;
  revocationReason?: string;
  refundAmountMina?: string;
  status: "idle" | "queued" | "running" | "succeeded" | "failed";
  stepCount: number;
  totalSteps: number;
  steps: LiveSessionTurnFlowStep[];
  completedStepLabels: string[];
  reportType?: "live-session-turn-flow";
  generatedAtIso?: string;
  requestedAtIso?: string;
  lastStartedAtIso?: string;
  lastFinishedAtIso?: string;
  currentStepLabel?: string;
  resumeFromStepLabel?: string;
  lastError?: string;
  attemptCount?: number;
  resumeAvailable?: boolean;
  jobId?: string;
  reportPath?: string;
  witnessPlanPath?: string;
}

export interface SponsorQueueJob {
  jobId: string;
  sessionId: string;
  amountMina: string;
  purpose: "onboarding" | "top-up" | "publish";
  status: "queued" | "running" | "succeeded" | "failed";
  requestedAtIso: string;
  startedAtIso?: string;
  finishedAtIso?: string;
  txHash?: string;
  note?: string;
  lastError?: string;
}

export interface SponsorQueueState {
  status: "idle" | "queued" | "running" | "failed";
  autoSponsorEnabled: boolean;
  pendingCount: number;
  activeJobId?: string;
  items: SponsorQueueJob[];
}

export interface AgentProfileState {
  agentName: string;
  representedPrincipal: string;
  headline: string;
  openClawUrl: string;
  payoutAddress?: string;
  preferredProvingLocation: PrivacyProvingLocation;
}

export interface AgentRegistryEntry {
  agentId: string;
  sessionId: string;
  networkId: string;
  agentName: string;
  representedPrincipal: string;
  headline: string;
  openClawUrl: string;
  trustModeId: TrustModeId;
  trustModeLabel: string;
  proofLevel: "signed" | "rooted" | "proof-backed";
  preferredProvingLocation: PrivacyProvingLocation;
  payoutAddressConfigured: boolean;
  paidJobsEnabled: boolean;
  published: boolean;
  lastUpdatedAtIso?: string;
}

export interface HireRequestReceipt {
  requestId: string;
  agentId: string;
  sessionId: string;
  networkId: string;
  submittedAtIso: string;
  status: "submitted";
  deliveryTarget: string;
  paidJobsEnabled: boolean;
}

export interface ConsoleStateResponse {
  agentId: string;
  payoutAddressConfigured: boolean;
  paidJobsEnabled: boolean;
  wallet: ShadowWalletState;
  trustModes: TrustModeCard[];
  ghostRun: GhostRunPlan;
  privacyExceptions: PrivacyExceptionQueueItem[];
  timeMachine: TimeMachineEntry[];
  session: SessionSummary;
  artifacts: ArtifactSummary[];
  deployment: ZekoDeploymentState;
  liveFlowTargets: LiveFlowTargets;
  liveFlow: LiveSessionTurnFlowState;
  sponsorQueue: SponsorQueueState;
  profile: AgentProfileState;
}

export const TRUST_MODE_PRESETS: TrustModeCard[] = [
  {
    id: "fast",
    label: "Fast",
    blurb: "For low-risk drafting and internal synthesis with minimal friction.",
    preset: "convenient",
    operatorVisible: true,
    providerVisible: true,
    proofLevel: "signed",
    maxSpendMina: "0.08",
    retention: "24h checkpoint",
    defaultArtifactVisibility: "user-visible",
    defaultProvingLocation: "client",
    supportedProvingLocations: ["client", "server", "sovereign-rollup"],
    stripe: ["Visible to your workspace", "Provider approved", "Quick retention"]
  },
  {
    id: "private",
    label: "Private",
    blurb: "Default mode for day-to-day work with sealed outputs and bounded disclosure.",
    preset: "private",
    operatorVisible: false,
    providerVisible: false,
    proofLevel: "rooted",
    maxSpendMina: "0.18",
    retention: "72h zero-retention",
    defaultArtifactVisibility: "operator-blind",
    defaultProvingLocation: "client",
    supportedProvingLocations: ["client", "server", "sovereign-rollup"],
    stripe: ["Visible only to you", "Operator blind", "Deleted after completion"]
  },
  {
    id: "verified",
    label: "Verified",
    blurb: "Adds denser receipts and stronger auditability for high-trust deliverables.",
    preset: "verifiable-minimal",
    operatorVisible: false,
    providerVisible: false,
    proofLevel: "proof-backed",
    maxSpendMina: "0.25",
    retention: "Checkpoint only",
    defaultArtifactVisibility: "operator-blind",
    defaultProvingLocation: "client",
    supportedProvingLocations: ["client", "server", "sovereign-rollup"],
    stripe: ["Operator blind", "Receipt complete", "Selective disclosure only"]
  },
  {
    id: "team-governed",
    label: "Team-governed",
    blurb: "For enterprise workflows with guardians, privacy exceptions, and shared review.",
    preset: "workspace-private",
    operatorVisible: false,
    providerVisible: false,
    proofLevel: "proof-backed",
    maxSpendMina: "0.40",
    retention: "Workspace sealed",
    defaultArtifactVisibility: "team-sealed",
    defaultProvingLocation: "client",
    supportedProvingLocations: ["client", "server", "sovereign-rollup"],
    stripe: ["Visible to your workspace", "Privacy exceptions required", "Compliance scoped"]
  }
];
