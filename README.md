# SantaClawz / ClawZ

SantaClawz is the privacy, verification, and settlement protocol implemented by ClawZ, a privacy-first, Zeko-native agent operating system.

This starter repo is organized around nine core concerns:

- `packages/protocol`: canonical leaves, manifests, receipts, privacy types, retention and disclosure objects, and golden vectors
- `packages/agent-sdk`: consumer client for discovery, proof retrieval, verifier endpoint access, MCP calls, and local bundle verification
- `packages/openclaw-adapter`: direct OpenClaw add-on package for mapping OpenClaw sessions into SantaClawz lineages and verifier endpoints
- `packages/contracts`: zkApp kernels and privacy primitives for approvals, disclosures, sessions, turns, and registry state
- `packages/key-broker`: tenant-scoped envelope encryption and key access policy
- `packages/blob-store`: sealed artifact storage with manifests, retention, and disclosure controls
- `apps/enterprise-kms`: regulated derivation bridge for HSM/KMS-backed `POST /derive-key`
- `apps/web-console` and `apps/indexer`: onboarding, trust/privacy UX, action replay, and audit surfaces
- `apps/privacy-gateway`: deployable KMS-compatible and sealed-object gateway for production privacy infrastructure

The design aims to keep Zeko responsible for control-plane truth while keeping raw user content encrypted and offchain by default.
ClawZ now defaults its shared key-broker runtime to durable local file-backed storage rather than ephemeral in-memory keys, so the privacy foundation survives restarts even before you swap in an external KMS.

OpenClaw is the baseline runtime dependency for the SantaClawz add-on path: existing OpenClaw operators can keep `openclaw` as the session, gateway, and MCP runtime, then layer `@clawz/openclaw-adapter` plus the ClawZ indexer/privacy services on top.

## Workspace

```bash
pnpm install
pnpm doctor
pnpm build
```

Run the built local stack:

```bash
pnpm start:indexer
pnpm start:web
```

Local defaults:

- web console: `http://127.0.0.1:4173`
- indexer API: `http://127.0.0.1:4318`
- enterprise KMS: `http://127.0.0.1:8791`
- privacy gateway: `http://127.0.0.1:8789`

Optional runtime configuration:

- `VITE_CLAWZ_API_BASE_URL` to point the console at a remote indexer
- `VITE_ZEKO_FAUCET_UI_URL` and `VITE_ZEKO_FAUCET_CLAIM_API_URL` to customize faucet links in the public console
- `CLAWZ_PUBLIC_ONBOARDING=true` to keep API auth enabled while exposing only the browser onboarding routes to the SantaClawz site
- `CLAWZ_DATA_DIR` to place durable indexer, blob, wrapped-key, and live-flow state on a mounted volume
- `CLAWZ_KEY_BROKER_DIR` to relocate durable local key material and wrapped keys
- `CLAWZ_KEY_BROKER_MODE=external-kms-backed` plus `CLAWZ_KMS_ENDPOINT` for an enterprise KMS/HSM boundary
- `CLAWZ_BLOB_STORE_MODE=http-object-store` plus `CLAWZ_BLOB_STORE_ENDPOINT` for object-store-backed sealed blobs
- `CLAWZ_ENTERPRISE_KMS_PROVIDER_MODE=command-adapter` to bridge the regulated derivation rail into an enterprise-owned adapter command or internal proxy
- `CLAWZ_REGULATED_ENTERPRISE=true` plus `CLAWZ_PRIVACY_GATEWAY_KEY_PROVIDER=external-hsm-derive` when the privacy gateway must run without root key material in process
- `CLAWZ_PRIVACY_PROVING_LOCATION=client|server|sovereign-rollup` to choose where proving happens
- `CLAWZ_SERVER_PROVER_URL` to advertise that application-data proofs are produced on the server
- `CLAWZ_SOVEREIGN_ROLLUP_ENABLED=true`, `CLAWZ_SOVEREIGN_ROLLUP_ENDPOINT`, and optionally `CLAWZ_SOVEREIGN_ROLLUP_STACK=docker-compose-phala` for the private Zeko sovereign-rollup path
- `CLAWZ_KEY_BROKER_MODE=in-memory-default-export` only for isolated test runs
- `CLAWZ_REQUIRE_API_AUTH=true`, `CLAWZ_API_KEY_SHA256`, and `CLAWZ_ALLOWED_ORIGINS` before exposing the indexer

Programmable privacy defaults to `client`, which is the recommended baseline for user-data privacy on power-user machines. Switch to `server` when the app operator owns the sensitive application context, or `sovereign-rollup` when regulated enterprise workloads should prove inside the private Zeko rollup path.

Developer health checks:

- `pnpm doctor` for a quick machine sanity pass
- `pnpm doctor:full` for deep local validation
- `pnpm doctor:testnet` for live Zeko readiness and verification-key alignment
- `pnpm preflight:production` for API auth, CORS, KMS, data-dir, and deployment-artifact checks
- `pnpm check:privacy-gateway` to verify deployed KMS + sealed-object endpoints before pointing the indexer at them
- `pnpm smoke:regulated-local` to boot the enterprise-KMS plus privacy-gateway chain locally and run the external-HSM preflight end to end

See `docs/production-hardening.md` for the production operator checklist.

See `docs/openclaw-addon.md` for the direct OpenClaw install path.

See `docs/spaceship-deployment.md` for packaging the public SantaClawz site for Spaceship hosting.

See `docs/render-backend-rollout.md` for the step-by-step Render plus Spaceship deployment order.

## Interoperable proof surface

The indexer now exposes a deterministic interop surface for answering the agent-to-agent trust
question directly:

- `GET /.well-known/agent-interop.json`
- `GET /.well-known/clawz-agent.json` (legacy alias)
- `GET /api/interop/agent-proof`
- `GET/POST /api/interop/verify`
- `POST /mcp`

That surface publishes reproducible proofs for:

- who the current agent represents
- what execution boundary it is allowed to operate within
- how it gets paid
- which privacy and disclosure rules govern the run
- where the proving boundary lives: client, server, or sovereign rollup

You can verify a running instance with:

```bash
pnpm verify:proof -- --url http://127.0.0.1:4318
```

Or consume it programmatically:

```ts
import { createClawzAgentClient } from "@clawz/agent-sdk";

const client = createClawzAgentClient({ baseUrl: "http://127.0.0.1:4318" });
const verification = await client.getVerification();
```

See `docs/interop-proof-surface.md` for the verification model.

For the planned remote-origin attestation rail, see `docs/zktls-adapter.md`.


## OpenClaw Add-On Path

Per the official OpenClaw install docs, existing operators can keep `openclaw` as the runtime:

```bash
npm install -g openclaw@latest
pnpm add @clawz/openclaw-adapter
```

Then point the OpenClaw deployment at the ClawZ verifier/indexer/privacy services and map each OpenClaw session into a SantaClawz lineage. The bundled adapter package keeps that boundary explicit without forcing a rewrite of the agent runtime.

## Zeko testnet deployment

`packages/contracts` accepts secrets from either environment variables or macOS Keychain.

Required:

- `DEPLOYER_PRIVATE_KEY`
- or Keychain service `ZekoAI_SUBMITTER_PRIVATE_KEY`

Recommended for stable contract addresses:

- `REGISTRY_PRIVATE_KEY` or `ClawZ_REGISTRY_PRIVATE_KEY`
- `SESSION_PRIVATE_KEY` or `ClawZ_SESSION_PRIVATE_KEY`
- `TURN_PRIVATE_KEY` or `ClawZ_TURN_PRIVATE_KEY`
- `APPROVAL_PRIVATE_KEY` or `ClawZ_APPROVAL_PRIVATE_KEY`
- `DISCLOSURE_PRIVATE_KEY` or `ClawZ_DISCLOSURE_PRIVATE_KEY`
- `ESCROW_PRIVATE_KEY` or `ClawZ_ESCROW_PRIVATE_KEY`

Compile and deploy:

```bash
pnpm compile:contracts
pnpm --filter @clawz/contracts check:vk-drift
pnpm preflight:testnet
pnpm deploy:testnet
```

Default Zeko endpoints:

- GraphQL: `https://testnet.zeko.io/graphql`
- archive: `https://archive.testnet.zeko.io/graphql`
