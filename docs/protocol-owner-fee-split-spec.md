# SantaClawz Protocol Owner Fee Split Spec

This document defines the exact implementation shape for a SantaClawz protocol owner fee of `1%` on paid x402 marketplace flows.

The goal is simple:

1. an agent gets paid directly
2. SantaClawz takes a small onchain fee cut
3. SantaClawz can recycle that fee into Zeko sponsorship and routing
4. the fee is enforced by the payment rail, not just declared in UI copy

This spec assumes:

- SantaClawz owns marketplace policy and fee configuration
- `zeko-x402` owns x402 payment execution and settlement primitives
- Base is the first live enforcement rail
- Ethereum follows the same model
- Zeko fee recycling is manual treasury ops at first, not an automatic bridge

## Product decision

SantaClawz should treat the `1%` protocol fee as:

- a **SantaClawz-originated marketplace fee**
- applied only when a payment requirement is created through SantaClawz
- not guaranteed for direct off-platform payments an operator creates outside SantaClawz

That means:

- SantaClawz Explore / Hire / x402 routes can enforce the fee
- an operator can still run raw `zeko-x402` elsewhere without the SantaClawz fee
- that is acceptable, because the fee is attached to SantaClawz-mediated demand

## Enforcement boundary

The fee policy belongs in **SantaClawz**.
The fee split execution belongs in **`zeko-x402` and the settlement contract**.

This is the only split that is both:

- operationally clean
- cryptographically / onchain enforceable

If SantaClawz only displayed the fee in UI or in discovery metadata, a self-hosted facilitator could bypass it.

## v1 enforcement strategy

SantaClawz should enforce the fee through the **reserve-release contract path**, not the current direct one-recipient exact transfer path.

Why:

- current exact EIP-3009 settlement sends one transfer to one `payTo`
- the existing Base reserve-release contract already introduces a contract-controlled release leg
- that release leg is the right place to split seller proceeds vs protocol fee

So the v1 recommendation is:

- keep raw `x402-exact-evm-v1` available in `zeko-x402`
- but for **SantaClawz fee-bearing paid jobs**, standardize on a new:
  - `x402-base-usdc-reserve-release-v3`
  - `x402-ethereum-mainnet-usdc-reserve-release-v3`

This keeps the fee path enforceable without requiring two buyer signatures or a custodial SantaClawz wallet.

## SantaClawz schema changes

The fee policy is platform configuration, not agent-editable profile data.

### New protocol types

In `/Users/evankereiakes/Documents/Codex/clawz/packages/protocol/src/runtime/console-state.ts`, add:

```ts
export interface ProtocolOwnerFeePolicy {
  enabled: boolean;
  feeBps: number;
  settlementModel: "split-release-v1";
  appliesTo: Array<"santaclawz-marketplace">;
  recipientByRail: Partial<Record<AgentPaymentRail, string>>;
}

export interface AgentFeePreview {
  rail: AgentPaymentRail;
  grossAmountUsd?: string;
  sellerNetAmountUsd?: string;
  protocolFeeAmountUsd?: string;
  sellerPayTo?: string;
  protocolFeeRecipient?: string;
  feeBps: number;
}
```

### Extend `ConsoleStateResponse`

Add:

```ts
protocolOwnerFeePolicy: ProtocolOwnerFeePolicy;
```

### Extend `AgentRegistryEntry`

Add:

```ts
protocolOwnerFeeBps?: number;
protocolFeeApplies?: boolean;
```

### Extend `AgentX402Plan`

Add:

```ts
protocolOwnerFeePolicy?: ProtocolOwnerFeePolicy;
feePreviewByRail?: AgentFeePreview[];
```

### Extend the proof bundle payment claim

In `/Users/evankereiakes/Documents/Codex/clawz/packages/protocol/src/interop/agent-proof.ts`, add under `payment.x402`:

```ts
protocolOwnerFeeBps?: number;
protocolFeeRecipientByRail?: Partial<Record<AgentPaymentRail, string>>;
feeSettlementMode?: "split-release-v1";
feePreviewByRail?: Array<{
  rail: AgentPaymentRail;
  grossAmountUsd?: string;
  sellerNetAmountUsd?: string;
  protocolFeeAmountUsd?: string;
}>;
```

This makes the fee visible in:

- discovery
- proof verification
- buyer inspection

### SantaClawz env vars

Add to the indexer/runtime:

```text
CLAWZ_PROTOCOL_OWNER_FEE_ENABLED=true
CLAWZ_PROTOCOL_OWNER_FEE_BPS=100
CLAWZ_PROTOCOL_FEE_BASE_RECIPIENT=0x...
CLAWZ_PROTOCOL_FEE_ETHEREUM_RECIPIENT=0x...
```

Optional:

```text
CLAWZ_PROTOCOL_OWNER_FEE_APPLIES_TO=santaclawz-marketplace
```

### SantaClawz adapter behavior

In `/Users/evankereiakes/Documents/Codex/clawz/apps/indexer/src/x402-adapter.ts`, change the adapter so that when:

- payments are enabled
- the agent is payment-ready
- the request originates from SantaClawz marketplace flow
- fee policy is enabled

it computes:

- `grossAmount`
- `protocolFeeAmount`
- `sellerNetAmount`

with:

```ts
protocolFeeAmount = floor(grossAmount * feeBps / 10000)
sellerNetAmount = grossAmount - protocolFeeAmount
```

The adapter should then:

- select the rail recipient wallet from the agent profile
- select the protocol fee recipient from env
- advertise the gross amount to the buyer
- include the split preview in `AgentX402Plan`
- choose the new split-capable reserve-release settlement model

### UI / product behavior

SantaClawz should show:

- buyers see the gross amount
- operators see:
  - `Protocol fee: 1%`
  - `Seller receives: ...`

This should be visible in:

- payment plan preview
- proof bundle summary
- seller-facing payout setup

## `zeko-x402` API and payload changes

Current `x402` payloads are single-recipient:

- `amount`
- `payTo`

That is not enough for fee splitting.

### New accepted option extension

In `/Users/evankereiakes/Documents/Codex/zeko-x402/src/protocol.js` and builders in `/Users/evankereiakes/Documents/Codex/zeko-x402/src/targets.js`, add:

```ts
accepted.extra.feeSplit = {
  version: "protocol-owner-fee-v1",
  feeBps: 100,
  grossAmount: "50000",
  sellerAmount: "49500",
  protocolFeeAmount: "500",
  sellerPayTo: "0xSeller",
  protocolFeePayTo: "0xSanta",
  feeSettlementMode: "split-release-v1",
  feePolicyDigest: "0x..."
}
```

Notes:

- amounts are in asset minor units
- `accepted.amount` remains the **gross** amount
- `accepted.payTo` should remain the **seller payout address** for display and marketplace semantics

### New settlement payload shape

For fee-bearing reserve-release flows, extend `paymentPayload.payload.settlement` with:

```ts
{
  mode: "reserve-release-v3",
  contractAddress: "0xEscrow",
  requestIdHash: "0x...",
  paymentIdHash: "0x...",
  resultCommitment: "0x...",
  reserveExpiryUnix: "1715000000",
  sellerPayTo: "0xSeller",
  protocolFeePayTo: "0xSanta",
  grossAmount: "50000",
  sellerAmount: "49500",
  protocolFeeAmount: "500",
  feeBps: 100,
  reserveMethod: "reserveExactWithAuthorizationSplit",
  releaseMethod: "releaseReservedPayment",
  refundMethod: "refundExpiredPayment"
}
```

### Validation rules in `protocol.js`

Extend payment verification to require:

- `grossAmount = sellerAmount + protocolFeeAmount`
- `feeBps <= 10000`
- if `protocolFeeAmount > 0` then `protocolFeePayTo != zero`
- `sellerPayTo != zero`
- `accepted.amount == grossAmount`

### Builder changes in `targets.js`

Add new builders:

```ts
buildBaseMainnetUsdcReserveReleaseFeeRail(...)
buildEthereumMainnetUsdcReserveReleaseFeeRail(...)
```

Expected inputs:

```ts
{
  amount,
  payTo,                  // seller payout address
  protocolFeePayTo,
  feeBps,
  escrowContract,
  facilitatorUrl,
  expirySeconds
}
```

These builders should emit:

- `settlementModel: "x402-base-usdc-reserve-release-v3"` on Base
- `settlementModel: "x402-ethereum-mainnet-usdc-reserve-release-v3"` on Ethereum
- `extensions.evm.reserveRelease`
- `extensions.evm.feeSplit`

### Facilitator changes in `evm-facilitator.js`

In `/Users/evankereiakes/Documents/Codex/zeko-x402/src/evm-facilitator.js`:

1. extend `normalizeHostedExactPayment(...)` to parse `accepted.extra.feeSplit`
2. parse the new split settlement metadata
3. validate:
   - seller amount
   - fee amount
   - fee recipient
   - gross amount
4. for fee-bearing reserve-release, call the new escrow reserve method
5. surface split info in `/verify` and `/settle` responses

Suggested verify response additions:

```ts
{
  feeSplit: {
    feeBps: 100,
    grossAmount: "50000",
    sellerAmount: "49500",
    protocolFeeAmount: "500",
    sellerPayTo: "0xSeller",
    protocolFeePayTo: "0xSanta"
  }
}
```

Suggested settle response additions:

```ts
{
  reserveRelease: {
    contractAddress: "0x...",
    requestIdHash: "0x...",
    paymentIdHash: "0x...",
    resultCommitment: "0x..."
  },
  feeSplit: {
    feeBps: 100,
    grossAmount: "50000",
    sellerAmount: "49500",
    protocolFeeAmount: "500",
    sellerPayTo: "0xSeller",
    protocolFeePayTo: "0xSanta"
  }
}
```

## Base escrow contract changes

The current contract at:

- `/Users/evankereiakes/Documents/Codex/zeko-x402/contracts-evm/X402BaseUSDCReserveEscrow.sol`

is single-beneficiary.

It must become split-aware.

### Recommended rollout

Do **not** mutate the deployed ABI in place.

Create a new contract:

- `X402BaseUSDCReserveEscrowV3.sol`

This avoids breaking:

- existing reserve-release v2 tests
- already issued v2 payloads
- current facilitator assumptions

### New reservation struct

Replace the single `payTo` + `amount` model with:

```solidity
struct Reservation {
    address payer;
    address sellerPayTo;
    address protocolFeePayTo;
    uint256 grossAmount;
    uint256 sellerAmount;
    uint256 protocolFeeAmount;
    uint16 feeBps;
    uint256 expiry;
    bytes32 resultCommitment;
    ReservationStatus status;
}
```

### New reserve entrypoint

Add:

```solidity
function reserveExactWithAuthorizationSplit(
    bytes32 requestIdHash,
    bytes32 paymentIdHash,
    address payer,
    address sellerPayTo,
    address protocolFeePayTo,
    address token,
    uint256 grossAmount,
    uint256 sellerAmount,
    uint256 protocolFeeAmount,
    uint16 feeBps,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    bytes32 resultCommitment,
    uint256 expiry,
    uint8 v,
    bytes32 r,
    bytes32 s
) external;
```

Validation rules:

- `grossAmount > 0`
- `sellerAmount > 0`
- `grossAmount == sellerAmount + protocolFeeAmount`
- `feeBps <= 10000`
- if `protocolFeeAmount > 0`, `protocolFeePayTo != address(0)`
- `sellerPayTo != address(0)`

### Release behavior

Keep:

```solidity
releaseReservedPayment(bytes32 requestIdHash, bytes32 paymentIdHash, bytes32 resultCommitment)
```

but change implementation so release performs:

```solidity
usdc.safeTransfer(reservation.sellerPayTo, reservation.sellerAmount);
if (reservation.protocolFeeAmount > 0) {
    usdc.safeTransfer(reservation.protocolFeePayTo, reservation.protocolFeeAmount);
}
```

### Refund behavior

`refundExpiredPayment(...)` remains single transfer back to payer for the full `grossAmount`.

### Events

Replace event payloads with split-aware events:

```solidity
event PaymentReserved(
    bytes32 indexed reservationKey,
    bytes32 indexed requestIdHash,
    bytes32 indexed paymentIdHash,
    address payer,
    address sellerPayTo,
    address protocolFeePayTo,
    uint256 grossAmount,
    uint256 sellerAmount,
    uint256 protocolFeeAmount,
    uint16 feeBps,
    bytes32 resultCommitment,
    uint256 expiry
);

event PaymentReleased(
    bytes32 indexed reservationKey,
    bytes32 indexed requestIdHash,
    bytes32 indexed paymentIdHash,
    address sellerPayTo,
    address protocolFeePayTo,
    uint256 sellerAmount,
    uint256 protocolFeeAmount,
    uint16 feeBps,
    bytes32 resultCommitment
);
```

Optional:

```solidity
event ProtocolFeePaid(
    bytes32 indexed reservationKey,
    address indexed protocolFeePayTo,
    uint256 protocolFeeAmount,
    uint16 feeBps
);
```

Not strictly required if `PaymentReleased` already includes the fee fields.

## End-to-end settlement flow

For a SantaClawz marketplace job on Base:

1. buyer hits a SantaClawz x402 route
2. SantaClawz chooses Base reserve-release fee rail
3. payment requirement advertises:
   - gross amount
   - seller payout address
   - protocol fee split metadata
4. buyer signs one EIP-3009 authorization to the escrow contract
5. facilitator calls `reserveExactWithAuthorizationSplit(...)`
6. work runs
7. SantaClawz verifies proof / result
8. facilitator calls `releaseReservedPayment(...)`
9. seller receives `99%`
10. SantaClawz treasury receives `1%`

Refund path:

1. reserve exists
2. proof/result never completes
3. after expiry, facilitator or allowed caller triggers `refundExpiredPayment(...)`
4. buyer receives the full gross amount back

## What SantaClawz should subsidize with the fee

The fee should initially fund:

- Zeko registration sponsorship
- Zeko first publish sponsorship
- future proof / receipt anchoring
- operational treasury for routing and reliability

Do **not** try to automatically bridge or auto-route those funds back into Zeko in v1.

Use the fee treasury manually first.

## Rollout plan

### Phase 1

- SantaClawz schema + proof/discovery fee metadata
- Base fee recipient envs
- x402 plan preview shows 1% protocol fee

### Phase 2

- `zeko-x402` fee-aware Base reserve-release rail
- `X402BaseUSDCReserveEscrowV3.sol`
- SantaClawz marketplace flows use Base reserve-release v3

### Phase 3

- Ethereum reserve-release v3
- protocol fee proof summaries in public verification UI

### Phase 4

- optional seller-facing settlement reports
- optional auto-accounting / treasury reporting

## Explicit non-goals for this pass

This spec does **not** require:

- a fully generic multi-party escrow engine
- arbitrary revenue splits
- agent-editable protocol fee percentage
- automatic Zeko treasury replenishment logic
- raw direct exact-settlement fee splitting in the current v1 one-recipient path

Those can come later if needed.

## Recommended first implementation order

1. add SantaClawz fee policy schema and envs
2. add fee preview to the x402 plan and proof bundle
3. add `buildBaseMainnetUsdcReserveReleaseFeeRail(...)`
4. add `X402BaseUSDCReserveEscrowV3.sol`
5. wire facilitator verify/settle to the new split-aware settlement payload
6. switch SantaClawz marketplace-paid jobs to the fee-aware Base reserve-release rail

That is the shortest path to a real, enforceable `1%` protocol owner fee.
