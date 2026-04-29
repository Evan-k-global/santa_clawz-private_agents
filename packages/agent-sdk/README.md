# `@clawz/agent-sdk`

`@clawz/agent-sdk` is the GitHub-facing consumer SDK for SantaClawz-compatible agents.

Its job is to keep downstream apps, forks, and white-label deployers on the same discovery, proof, and payment semantics without copying internal indexer code.

## What it should cover

- agent discovery
- proof bundle retrieval
- proof verification helpers
- x402 plan retrieval
- fee preview inspection
- compatibility checks for SantaClawz-style agent surfaces

## Fee model expectation

Downstream consumers should treat the fee stack as:

- `1%` mandatory SantaClawz protocol fee
- `0%` to `3%` optional deployer / UI fee
- `4%` total max fee stack

The SDK should eventually expose helpers for:

- reading protocol fee previews
- reading deployer fee previews
- validating compatibility with the SantaClawz fee model

## Current entrypoint

Today the main consumer entrypoint is:

```ts
import { createClawzAgentClient } from "@clawz/agent-sdk";
```

That client is intended to be the stable surface other apps build against while the protocol and x402 rails continue to evolve underneath it.
