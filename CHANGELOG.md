# Changelog

## [1.0.0-stable] — v1-stable subtract

Carve VCS back to the minimal hierarchical context DB described in `ANALYSIS.md §7`. Everything else is either deleted or gated behind an opt-in flag. Every deletion remains reachable via the `gsd/phase-44-auto-rebalance-on-write` branch if a future milestone wants to rehabilitate it.

### Removed

- **Phase 44 auto-rebalance.** `rebalanceUri`, `countChildren`, `getCanonicalPointer`, `vcs_resolve_canonical_uri` MCP tool, `tree --collapse-buckets`, pointer rows, `REBALANCE_FANOUT_THRESHOLD`.
- **Phase 43 scheduler state machine.** `claimParentForRollup`, `completeParentRollup`, `releaseRollupClaim`, `markParentDirty`, dirty-cycle tokens, `rollup_in_progress_since` leases, `rollup_cost_window_*` cost circuit breaker. Replaced with a single conditional `UpdateItem` in `tryStartRollup`.
- **AgentCore Memory.** `memory-bridge` Lambda, `src/services/agentcore.ts`, `CfnMemory`, `MemoryPayloadTopic`, `MemoryBridgeDlq`, `bedrock-agentcore` IAM actions, SNS/S3 resource policies, the 3 memory strategies, `/vcs/data/agentcore-memory-id` SSM path. Phase 45 (AGNT-01..08) cancelled.
- **Wiki knowledge compiler.** `src/lambdas/compiler/`, `src/lambdas/lint/`, `compileQueue`, `compileDlq`, `COMPILER_SCOPES`, `enqueueCompile`, `/compile` and `/lint` routes, `scripts/seed-wiki.ts`, the weekly lint EventBridge rule, `viking://wiki/*`, `viking://schema/*`, and `viking://compile/*` seeded root directories.
- **Viking Explorer browser.** `browser/` (Vite + React + shadcn SPA), `lib/constructs/hosting-layer.ts` (S3 + CloudFront), `src/lambdas/vectors/` (list endpoint exclusively used by the map view), `/vectors` route.
- **Evaluation harness from the prod stack.** `VcsEvalStack` is no longer instantiated from `bin/vcs.ts`. It lives in its own CDK app at `bin/vcs-eval.ts`.
- **Nova Pro and Claude Haiku.** `HAIKU_MODEL_ID`, `NOVA_PRO_MODEL_ID`, `getHaikuModelId`, `getProModelId`, `resolveModelId` CRIP helper. IAM policies on every Lambda drop the `us.anthropic.claude-*` / `global.anthropic.claude-*` inference-profile resources. Only `amazon.nova-micro-v1:0`, `amazon.nova-lite-v1:0`, and `amazon.titan-embed-text-v2:0` remain.
- **All stale tests**: Phase-43 scheduler tests, compiler tests (8 files), lint-checks test, memory-bridge test, agentcore test, dynamodb-rollup test, config CRIP test, handler.test.ts for the old parent-summariser claim/complete/release machine.

### Added

- `MILESTONE.md` at repo root with the v1-stable Definition of Done and the 12-phase subtraction map.
- `tsconfig.src.json` — strict typecheck over `bin/` `lib/` `src/` only (vitest globals in `tests/` would otherwise need `@types/vitest` plumbing).
- `bin/vcs-eval.ts` — separate CDK app entry for the eval stack.
- `tests/smoke/e2e.test.ts` — the single end-to-end smoke required by the DoD: ingest → rollup → read at L0/L1/L2 → find.
- `tests/unit/rollup-scheduler.test.ts` — minimal coverage of the new `enqueueRollup` content-based dedup.
- `npm run typecheck` and `npm run test:e2e` scripts.

### Changed

- **Rollup scheduler.** Single conditional UpdateItem enforces cooldown and acts as the claim. SQS FIFO `MessageGroupId = sha256(parentUri)` serialises per-parent delivery; `MessageDeduplicationId = sha256(parentUri)` coalesces bursts inside the 5-minute SQS dedup window. On crash mid-rollup, the next upstream write re-enqueues past the cooldown naturally — no lease to release, no dirty token to reset.
- **Session commit flow.** No longer dual-writes to AgentCore. Archives to S3, writes session L0/L1/vector, TTLs the session, enqueues `viking://session/` rollup. Response shape loses `memory_extraction` / `extraction_job_id`.
- **Query Lambda.** `performSearch` routes every sub-query through S3 Vectors drill-down. Memory records under `viking://user/memories/` are discoverable via the same path as every other hierarchy.
- **AgentCore Gateway construct** is retained in the repo but not instantiated by default. Opt in with `cdk deploy VcsStack -c useAgentCoreGateway=true`.
- **`loadAllParams`** now accepts `readonly string[]` so `HANDLER_PARAMS.x as const` tuples can be passed directly. Fixes the 5 TS2345 errors this caused across the Lambda handlers.
- **README** rewritten around the minimal surface: `cdk deploy VcsStack`, `POST /resources`, `GET /fs/read`, `POST /search/find`. One page, four commands.

### Fixed

- All pre-existing TypeScript errors cleared. `npm run typecheck` is green on every file under `bin/`, `lib/`, and `src/`:
  - `src/services/dynamodb.ts` batch-write type plumbing uses a proper `BatchRequestItems` type alias instead of `Record<string, unknown[]>` casts
  - `src/services/bedrock.ts` and `src/services/s3-vectors.ts` cast to `DocumentType`-compatible shapes at the AWS SDK call sites
  - `src/lambdas/mcp-tools/handler.ts` guards the `tracer.setSegment` finally block against `undefined`
  - `src/types/session.ts::ToolPart.input`/`output` widened to optional to match the zod schema

### Deferred to v1.1+

- Extraction of the deleted subsystems into sibling repos (`viking-wiki`, `viking-explorer`, `viking-eval`).
- Session-level entity extraction (2 Bedrock calls on commit per `ANALYSIS.md §1.4`).
- Auto-rebalance on write.
- Nova Pro / Haiku for larger-context use cases.
- EventBridge emission of `vcs.resource.ingested` for downstream subscribers.
