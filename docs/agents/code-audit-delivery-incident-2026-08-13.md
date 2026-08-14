# Hosted Code Audit Delivery Incident - 2026-08-13

## Summary

One Magic City hire of the hosted SantaClawz Code Audit Agent was acknowledged by
the worker but rejected before delivery. A later retry completed successfully,
so this was not evidence of a persistent Magic City-to-SantaClawz integration
failure. It was a worker-side transient failure with an avoidable dependency
coupling in the Code Audit worker.

This note records the evidence, the limits of that evidence, and the narrowly
scoped worker hardening prepared in commit `d1c9cce`.

## Affected execution

| Field | Value |
| --- | --- |
| Magic City session | `cs-191` |
| SantaClawz request | `hire_d175b3a5461c` |
| Result | `SELLER_FAILED_NO_SETTLEMENT` / `return_rejected` |
| Settlement | No Base USDC settled; Magic City returned the held credits |
| Worker response | HTTP `503` |

The execution-state API showed `worker_ack: completed` but
`worker_completed: not_reached`. The relay sent the worker call at
`2026-08-13T22:28:31.343Z`; SantaClawz recorded the failed delivery at
`2026-08-13T22:28:32.579Z`. The worker therefore failed quickly rather than
timing out.

## What we know and what we do not

### Confirmed

- Magic City submitted a normal SantaClawz hire.
- The SantaClawz worker endpoint responded with HTTP `503`.
- SantaClawz correctly rejected the failed return and did not settle the payment.
- A subsequent Code Audit run succeeded on the live route.

### Not confirmed

The public execution-state endpoint records the status code but not the
worker's internal exception body. We therefore cannot prove that a particular
upstream provider, Render process, or configuration value caused this exact
`503` without the worker's private logs.

The source did expose a material reliability risk: it made OpenAI enrichment
mandatory by default. A temporary OpenAI failure could therefore turn an
otherwise valid deterministic audit into the same HTTP `503` delivery failure.
That is a defensible hardening target even though it is not proof of the exact
incident cause.

## Pre-change behavior

The hosted worker already produces deterministic repository findings, Markdown
reports, hashes, and a verification manifest. It also requests optional model
insights. Before this patch:

- `CODE_AUDIT_REQUIRE_OPENAI` defaulted to `true`.
- A non-completed model-insight request raised `WorkerError(..., 503,
  "code_audit_model_unavailable")`.
- Render allowed up to two 110-second model attempts while the public platform
  relay has a materially smaller response window.
- The direct worker failure payload used an object for `error`, although the
  canonical return shape expects a string.

Together, those conditions could make a valid paid audit unavailable because a
supplemental model call was slow, unavailable, or returned malformed data.

## Changes in `d1c9cce`

The patch changes only the hosted Code Audit worker and its deployment/test
configuration. It does **not** modify Magic City routing, credits, x402
handling, mission-bound auth, or the SantaClawz protocol relay.

1. **Deterministic delivery is the default.**
   `CODE_AUDIT_REQUIRE_OPENAI` now defaults to `false`. Operators who need a
   model-required policy can still set it explicitly to `true`.
2. **Model work has a real budget.**
   The worker has a 90-second relay response budget, reserves 35 seconds for
   deterministic audit/serialization, and limits optional model enrichment to
   at most two attempts. The Render defaults are 26 seconds per attempt with a
   two-second backoff, or 54 seconds total.
3. **Direct returns are canonical.**
   The worker guarantees the required verification-manifest collection fields
   and emits a string `error` plus structured `failure` details on failure.
4. **Regression coverage protects the contract.**
   Contract tests cover canonical failure payloads, manifest normalization, and
   the bounded model-enrichment window.

## Files changed

- `examples/agents/code-audit-agent-render-demo/santaclawz_real_worker_bridge.py`
- `examples/agents/code-audit-agent-render-demo/render.yaml`
- `examples/agents/code-audit-agent-render-demo/README.md`
- `examples/agents/code-audit-agent-render-demo/test_worker_contract.py`

## Verification performed

```bash
PYTHONPYCACHEPREFIX=/tmp/magic-city-pycache python3 -m py_compile \
  examples/agents/code-audit-agent-render-demo/santaclawz_real_worker_bridge.py \
  examples/agents/code-audit-agent-render-demo/test_worker_contract.py

PYTHONPYCACHEPREFIX=/tmp/magic-city-pycache python3 \
  examples/agents/code-audit-agent-render-demo/test_worker_contract.py
```

Result: 3 tests passed.

## Deployment and validation

The patch must be merged to the SantaClawz deployment branch and deployed to
the `santaclawz-code-audit-agent` Render service before it affects production.
After deployment:

1. Submit the same public GitHub repository audit through Magic City.
2. Confirm SantaClawz reports an accepted result, not `return_rejected`.
3. Confirm Magic City renders the Markdown report and JSON artifact.
4. Exercise one run with the model provider unavailable or disabled; it should
   still deliver the deterministic audit rather than return HTTP `503`.

If a `503` recurs after this patch, inspect the private Render worker logs using
the request ID and incident timestamp above. At that point the remaining likely
causes are worker process health, private relay routing, or a non-model runtime
exception, rather than the former mandatory-enrichment path.
