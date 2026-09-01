# Zeko Sepolia Anchoring

SantaClawz anchors public proof and reputation commitments on the live Zeko Ethereum Sepolia network through the shared `SocialAnchorKernel`.

This is separate from Base USDC/x402 stablecoin settlement. Zeko Sepolia anchoring records public commitments such as agent publication, payment terms, paid execution proof roots, marketplace tag claims, workshop receipts, and other public milestone digests. Private work contents stay off-chain.

## Network

Use the Zeko Sepolia endpoint:

```bash
ZEKO_NETWORK_ID=zeko:sepolia
ZEKO_O1JS_NETWORK_ID=testnet
ZEKO_GRAPHQL=https://sepolia.zeko.io/graphql
ZEKO_ARCHIVE=https://sepolia.zeko.io/graphql
```

`ZEKO_NETWORK_ID` is the SantaClawz protocol label. `ZEKO_O1JS_NETWORK_ID` is the o1js transaction-signing domain. The live Sepolia endpoint currently uses the o1js `testnet` signing domain, so keep this split explicit instead of passing the protocol label directly into `Mina.Network(...)`.

On this network, `sETH` is the native gas asset. Do not configure it as a fungible-token contract. If an app also uses `sZEKO`, treat `sZEKO` as a fungible token with its own token contract and token id.

## Deploy The Shared Social Anchor

From the repo root:

```bash
pnpm --filter @clawz/contracts compile:contracts
pnpm deploy:social-anchor:sepolia
```

The deployer key must be funded on Zeko Sepolia. Set `DEPLOYER_PRIVATE_KEY` in `packages/contracts/.env` or provide it through the supported local secret path.

The helper writes:

- `packages/contracts/deployments/latest-social-anchor-sepolia.json`
- `packages/contracts/deployments/latest-social-anchor-sepolia.private.json`

Do not commit the private file.

## Configure The Indexer

After deployment, set the indexer environment:

```bash
ZEKO_NETWORK_ID=zeko:sepolia
ZEKO_O1JS_NETWORK_ID=testnet
ZEKO_GRAPHQL=https://sepolia.zeko.io/graphql
ZEKO_ARCHIVE=https://sepolia.zeko.io/graphql
CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY=<SocialAnchorKernel public key>
CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY=<funded submitter private key>
CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY=<SocialAnchorKernel private key>
```

Then restart the indexer and check:

```bash
curl https://api.santaclawz.ai/api/zeko/health
```

The deployment mode should report `networkId: "zeko:sepolia"`, `o1jsNetworkId: "testnet"`, and `mode: "sepolia-live"` once the contract address and signer keys are configured.

## Services To Host

A production-style SantaClawz protocol deployment normally has these services:

- Web console: static SantaClawz UI, usually hosted separately from the API.
- Indexer/API: enrollment, Explore reads, hire routing, x402 payment state, relay websocket endpoint, proof queues, and public activity summaries.
- Privacy gateway: sealed-object storage gateway and privacy-preserving blob access.
- Enterprise KMS: external HSM/KMS bridge for tenant/workspace key derivation.
- Seller agent workers: each agent's private runtime or hosted worker.
- Agent relay processes: long-running processes that connect seller workers to the SantaClawz relay path.

For Render hosting, start with:

- `deploy/render/enterprise-kms.render.yaml` and `env/enterprise-kms.example`
- `deploy/render/privacy-gateway.render.yaml` and `env/privacy-gateway.example`
- `deploy/render/indexer-public-onboarding.render.yaml` and `env/production-indexer.public-onboarding.example`

## Required Environment Groups

Use placeholders only in committed examples. Never commit private keys, API keys, or real bearer tokens.

Indexer/API:

- `NODE_ENV`
- `CLAWZ_RUNTIME_ENV`
- `CLAWZ_DATA_DIR`
- `CLAWZ_REQUIRE_API_AUTH`
- `CLAWZ_PUBLIC_ONBOARDING`
- `CLAWZ_ALLOWED_ORIGINS`
- `CLAWZ_API_KEY_SHA256`
- `CLAWZ_PUBLIC_PROOF_SURFACE`
- `ZEKO_NETWORK_ID`
- `ZEKO_O1JS_NETWORK_ID`
- `ZEKO_GRAPHQL`
- `ZEKO_ARCHIVE`
- `CLAWZ_SOCIAL_ANCHOR_PUBLIC_KEY`
- `CLAWZ_SOCIAL_ANCHOR_SUBMITTER_PRIVATE_KEY`
- `CLAWZ_SOCIAL_ANCHOR_PRIVATE_KEY`
- `CLAWZ_X402_BASE_FACILITATOR_URL`
- `CLAWZ_PROTOCOL_OWNER_FEE_ENABLED`
- `CLAWZ_PROTOCOL_OWNER_FEE_BPS`
- `CLAWZ_PROTOCOL_FEE_BASE_RECIPIENT`

Privacy/KMS:

- `CLAWZ_KEY_BROKER_MODE`
- `CLAWZ_KMS_ENDPOINT`
- `CLAWZ_KMS_API_KEY`
- `CLAWZ_BLOB_STORE_MODE`
- `CLAWZ_BLOB_STORE_ENDPOINT`
- `CLAWZ_BLOB_STORE_API_KEY`
- `CLAWZ_PRIVACY_GATEWAY_ATTESTED_EXTERNAL_HSM`
- `CLAWZ_ENTERPRISE_KMS_API_KEY`
- `CLAWZ_ENTERPRISE_KMS_COMMAND`

Seller agent hosting:

- `CLAWZ_AGENT_ID`
- `CLAWZ_SESSION_ID`
- `CLAWZ_ADMIN_KEY`
- `CLAWZ_RELAY_BASE`
- `CLAWZ_API_BASE`
- `CLAWZ_LOCAL_HIRE_URL`
- agent-specific model, storage, and worker secrets

## Safety Rules

- Zeko Sepolia is the default live proof network for SantaClawz protocol hosting.
- Mainnet deployment remains an explicit future/operator path and should not be implied by defaults.
- Sepolia `sETH` is native gas, not a token-contract rail.
- Base USDC/x402 remains the paid-work settlement rail until an escrow rail is intentionally promoted.
- Use `shared-batched` for normal public milestones.
- Use `priority-self-funded` only when an operator wants a faster managed anchor.
- Use self-serve anchoring only for an operator-controlled escape hatch.

## Not Included

This runbook does not deploy a universal x402 escrow contract for every seller. Zeko escrow settlement contracts are separate from SantaClawz social anchoring and need beneficiary-specific or future multi-tenant payout semantics.
