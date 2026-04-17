# OpenViking-as-AWS-Service: Hypothesis Validation

## Executive Summary

**Hypothesis:** OpenViking's core concepts (L0/L1/L2 tiered loading, viking:// filesystem, directory recursive retrieval, session memory commits) can be built as a high-level AWS-native service.

**Verdict: Validated.** The concepts are implementable on AWS primitives. But the build-vs-run decision favours a phased approach: learn from OpenViking first, then build AWS-native informed by operational experience.

**Recommendation: Option D — Learn, then build.**
- Phase 1 (now): Run OpenViking on ECS as private research tool (synthetic data, air-gapped)
- Phase 2 (concurrent): Publish evaluation content, position as context engineering expert
- Phase 3 (month 3-5): Build AWS-native service using DynamoDB + S3 + Bedrock + Lambda + SQS
- Phase 4 (month 5+): Package as CDK construct or managed service

---

## 1. OpenViking Core Concepts → AWS Service Mapping

### 1.1 Hierarchical Namespace (viking:// filesystem)

**OpenViking:** Virtual filesystem with `viking://` URIs. Three top-level scopes: resources, user, agent. Each URI maps to a node in a tree with parent-child relationships.

**AWS implementation:** DynamoDB table with composite key designed around the access patterns:

**Primary table:**

| Key | Type | Example | Purpose |
|---|---|---|---|
| PK | `uri` | `viking://resources/docs/auth/oauth.md` | Unique resource identifier |
| SK | `level` | `0`, `1`, or `2` | Fetch specific tier or all tiers |
| parent_uri | attribute | `viking://resources/docs/auth/` | Tree navigation |
| context_type | attribute | `resource` | Scoped search filtering |
| l0_text | attribute | `OAuth 2.0 implementation guide...` | Inline abstract for fast retrieval |
| created_at | attribute | `2026-03-19T10:00:00Z` | Ordering |

**Access patterns:**

| Pattern | Query | How |
|---|---|---|
| Fetch L0 only (cheap scan) | `PK = uri, SK = 0` | Single item read |
| Fetch all tiers | `PK = uri` | Query returns L0, L1, L2 items |
| List children (ls) | GSI: `PK = parent_uri` | Returns direct children |
| Scoped search filter | GSI: `PK = context_type, SK = uri` | All resources, all memories, etc. |
| Tree walk (recursive ls) | GSI: `PK = parent_uri`, recurse | Breadth-first traversal |

This design means an agent can load L0 for relevance checking (one item read, ~100 tokens), then fetch L2 only when needed (separate item read, full content from S3). The three-tier access is baked into the key design, not application logic.

**Multi-tenancy:** Handled at the AWS account level (each deployment in its own account), not via an application-level `account_id` field. This is the AWS-native isolation pattern. If SaaS multi-tenancy is needed later, add `account_id` as a PK prefix then. Do not pre-optimise for it now.

**Feasibility: HIGH.** DynamoDB is purpose-built for hierarchical key-value with GSI-based queries. Latency: single-digit milliseconds.

### 1.2 L0/L1/L2 Tiered Summarisation

**How OpenViking actually does it:** A single LLM call per node. The `VLMProcessor` (`parse/vlm.py`) takes raw content (text, images, tables) and returns structured JSON with `abstract` (L0), `overview` (L1), and `detail_text` (L2) in one shot. For multimodal content (PDFs with images), it uses vision model completion to process images and text together. The `SemanticDagExecutor` (`storage/queuefs/semantic_dag.py`) handles bottom-up dependency ordering via an async DAG, not a workflow engine. Each node is one model call. Parent directories get their L0/L1 by feeding children's abstracts into another single model call.

**Key insight: the model IS the pipeline.** There is no orchestration tool managing the summarisation. It is an async queue calling the model repeatedly with the right inputs.

**AWS implementation:** Lambda + SQS, matching OpenViking's pattern:

```
S3 PutObject (new content)
  → EventBridge rule
    → Lambda "Ingestion Handler":
        1. Read content from S3
        2. Call Bedrock (Claude Haiku/Sonnet) with structured prompt:
           "Return JSON: {abstract: ~100 tokens, overview: ~2k tokens,
            sections: [...]}"
           Single call. Multimodal-capable (text + images).
        3. Write L0/L1 to DynamoDB, L2 stays in S3
        4. Generate embeddings (Bedrock Titan Embeddings)
        5. Write vectors to OpenSearch/S3 Vectors
        6. If parent directory exists, enqueue parent to SQS

SQS "Parent Summary Queue"
  → Lambda "Parent Summariser":
    1. Read all children's L0 abstracts from DynamoDB
    2. Call Bedrock: "Synthesise these abstracts into a
       directory overview" (single call)
    3. Write parent L0/L1 to DynamoDB
    4. If grandparent exists, enqueue grandparent to SQS
```

This is exactly what OpenViking does with its `SemanticDagExecutor` + async queue, mapped to Lambda + SQS instead of Python asyncio. No workflow engine needed.

**Why not Step Functions:** Step Functions would add orchestration complexity for what is fundamentally "feed content to a model, get structured output back." The model does the heavy lifting. The only orchestration needed is bottom-up dependency ordering, which is a simple SQS queue with a readiness check.

**Feasibility: HIGH.** Bedrock Claude/Nova handles text + images in a single multimodal call, returns structured JSON via tool use or JSON mode. Cost per document: ~$0.005-0.02 (Haiku) or ~$0.02-0.10 (Sonnet).

### 1.3 Directory Recursive Retrieval

**OpenViking:** Intent analysis → global vector search → lock high-score directory → recursive search within children → convergence detection → rerank.

**AWS implementation:** Lambda function orchestrating:

1. **Intent analysis** (Bedrock): Generate 1-5 typed queries from user input
2. **Global search** (OpenSearch): Vector search filtered by `account_id` and `context_type`, return top 3 directories
3. **Recursive drill** (Lambda loop):
   - For each high-score directory, search OpenSearch filtered by `parent_uri` prefix
   - Score = 0.5 * embedding_score + 0.5 * parent_score
   - If subdirectories found with score > threshold, recurse
   - Stop when top-k stable for 3 rounds
4. **Return** matched contexts with URIs, levels, scores, and L0 abstracts

**Feasibility: MEDIUM-HIGH.** The recursive search requires multiple OpenSearch queries per retrieval. Latency depends on tree depth (typically 3-5 levels). Expected: 200-500ms per retrieval. OpenSearch Serverless supports prefix filtering on keyword fields.

**Key risk:** OpenSearch Serverless has a minimum cost (~$175/mo for 2 OCUs). S3 Vectors ($0.06/GB/mo) could serve as a cheaper alternative for smaller corpora but with higher latency.

### 1.4 Session Memory Extraction

**How OpenViking actually does it:** At session commit, a single LLM call extracts memory candidates across 6 categories (profile, preferences, entities, events, cases, patterns) as structured JSON. A second LLM call handles deduplication decisions (skip/create/merge/delete) against vector-matched existing memories. Two model calls, not a multi-step pipeline.

**AWS implementation:** Lambda triggered by session commit API call:

```
POST /session/{id}/commit
  → Lambda "Session Commit Handler":
    1. Read session messages from DynamoDB
    2. Call Bedrock: "Extract memories as structured JSON"
       (single call, returns all 6 categories)
    3. For each candidate: vector-search existing memories
       in OpenSearch/S3 Vectors
    4. Call Bedrock: "Deduplicate: skip/create/merge/delete"
       (single call with candidates + existing matches)
    5. Write new/merged memories to DynamoDB + embeddings
    6. Archive session messages to S3
    7. If new memories created, enqueue parent dirs to SQS
       for L0/L1 rollup
```

**Feasibility: HIGH.** Two Bedrock calls per session commit. The extraction and dedup patterns match AgentCore Memory's approach, but with the added hierarchy layer writing memories into the correct `viking://user/memories/{category}/` path in DynamoDB.

### 1.5 Visualised Retrieval Trajectory

**OpenViking:** Every retrieval step is logged with URI paths visited, scores at each level, and final selection reasoning.

**AWS implementation:** CloudWatch Logs structured JSON + X-Ray traces. Each Lambda invocation in the retrieval chain logs the directory visited, score, and decision. X-Ray provides the visual trace.

**Feasibility: HIGH.** This is observability, not architecture. CloudWatch and X-Ray handle it natively.

---

## 2. AgentCore Memory: Capabilities and Gaps

### What AgentCore Memory provides:

| Capability | Details |
|---|---|
| Semantic memory extraction | Extracts facts from conversations automatically |
| Episodic memory | Captures structured episodes (goal, reasoning, actions, outcomes, reflections) |
| User preference tracking | Separate track for stated preferences |
| Async extraction | 20-40s processing, ~200ms retrieval |
| Override strategies | Custom instructions and model selection |
| IAM integration | Native AWS security model |
| Managed infrastructure | No servers to operate |

### What AgentCore Memory lacks (confirmed gaps):

| Gap | Impact |
|---|---|
| **No hierarchical structure** | Memories are flat records, no parent-child relationships |
| **No L0/L1/L2 tiers** | No multi-resolution representations of the same content |
| **No scoped search** | Cannot search "within this directory" — all search is global |
| **No filesystem metaphor** | No URI-based navigation, no ls/tree/find operations |
| **No resource ingestion** | Designed for conversation memory, not document corpora |
| **No graph relationships** | No edges between related memories |
| **No temporal tracking** | No "when was this fact true" vs "when was it ingested" |
| **No token efficiency optimisation** | Cannot load L0 first, then drill to L2 on demand |

### Verdict on Option B (Extend AgentCore Memory):

**Not recommended.** AgentCore Memory's data model is fundamentally flat. Adding hierarchy on top means:
- Writing a custom query planner that translates tree traversals into filter chains
- Maintaining a shadow hierarchy in DynamoDB that AgentCore Memory knows nothing about
- Losing the ability to use AgentCore's native search (which doesn't support parent_uri filtering)
- Paying for AgentCore Memory's extraction pipeline AND your own hierarchy management

You would be building a database engine on top of a storage API. Worst of both worlds.

---

## 3. Competitor Landscape

| Service | Hierarchy | L0/L1/L2 | Temporal | Graph | Managed | Token Efficiency |
|---|---|---|---|---|---|---|
| **AgentCore Memory** | No | No | No | No | Yes | Minimal |
| **Mem0** | Scoped (user/session/agent) | No | No | Pro only | Cloud | 80% claim |
| **Zep/Graphiti** | No | No | Yes | Yes | Cloud | Good |
| **Letta/MemGPT** | 3-tier (core/recall/archival) | No | No | No | Hybrid | Good |
| **Cognee** | No | No | No | Yes | OSS | N/A |
| **OpenViking** | Yes (filesystem) | Yes | No | No | No | 83% (LoCoMo10) |
| **Custom AWS** | Yes (buildable) | Yes (buildable) | Yes (Neptune) | Yes (Neptune) | Self-managed | Buildable |

**Key finding:** No single solution combines hierarchical tiers + temporal graphs + managed infrastructure. This is the market gap.

---

## 4. Cost Analysis

### Option C: OpenViking on ECS

| Component | Monthly Cost |
|---|---|
| ECS Fargate (0.5 vCPU, 4GB) | ~$30 |
| EFS (10GB) | ~$3 |
| OpenAI API (embeddings + summarisation) | ~$5-20 |
| **Total** | **~$40-55/mo** |

### Option A: Custom AWS-Native (with OpenSearch Serverless)

| Component | Monthly Cost (POC) | Monthly Cost (Production) |
|---|---|---|
| DynamoDB (on-demand, <1M reads/mo) | ~$2 | ~$10 |
| OpenSearch Serverless (2 OCUs min) | ~$175 | ~$175 |
| S3 (content storage, <10GB) | ~$0.25 | ~$1 |
| Bedrock (summarisation + extraction) | ~$5-20 | ~$20-50 |
| Lambda (ingestion + query + session) | ~$1 | ~$5 |
| SQS (parent rollup queue) | ~$0.01 | ~$0.10 |
| API Gateway | ~$3.50 | ~$10 |
| **Total** | **~$187/mo** | **~$225-255/mo** |

**OpenSearch Serverless is the cost cliff.** At $175/mo minimum, it dominates the budget. Alternatives:

- **S3 Vectors** ($0.06/GB/mo): 90% cheaper but higher latency (seconds for cold, ~100ms warm). Viable for small corpora where latency tolerance is >500ms.
- **OpenSearch on EC2** (t3.medium): ~$35/mo but requires management.
- **Self-managed vector index in Lambda** (FAISS/hnswlib loaded from S3): ~$0 but limited corpus size and cold start issues.

**Recommended POC path:** Start with S3 Vectors for cost. Move to OpenSearch Serverless when latency requirements demand it.

### Option A: Custom AWS-Native (with S3 Vectors — recommended for POC)

| Component | Monthly Cost (POC) |
|---|---|
| DynamoDB | ~$2 |
| S3 Vectors | ~$1 |
| S3 (content) | ~$0.25 |
| Bedrock (Haiku for summarisation, Titan for embeddings) | ~$3-10 |
| Lambda (ingestion + query + session commit) | ~$0.50 |
| SQS (parent rollup queue) | ~$0.01 |
| API Gateway | ~$3.50 |
| **Total** | **~$10-18/mo** |

Note: No Step Functions in the cost model. The architecture uses direct Lambda invocations + SQS for async ordering, matching how OpenViking uses its async DAG executor internally. This reduced cost by eliminating the Step Functions line item and better reflects the actual pattern.

### AgentCore Memory comparison:

At 100K events + 10K memories + 20K retrievals/month:
- AgentCore Memory: ~$42.50/mo
- Custom AWS (S3 Vectors): ~$10-18/mo
- Custom AWS (OpenSearch): ~$187/mo

---

## 5. Build-vs-Extend Recommendation

### Recommendation: Option D — Learn, Then Build

**Phase 1: Learn (Now → Month 3)**
- Run OpenViking on ECS (already in progress)
- Air-gapped repository, synthetic data only
- Goal: deeply understand the L0/L1/L2 pattern, recursive retrieval algorithm, and session memory extraction through hands-on experience
- Blog the experience (OpenViking series already drafted)

**Phase 2: Design (Month 2-3, overlapping)**
- Document the AWS-native architecture informed by OpenViking learnings
- Identify which OpenViking patterns are essential vs nice-to-have
- Cost model refined with real usage data
- Publish architecture blog post

**Phase 3: Build (Month 3-5)**
- MVP: DynamoDB hierarchy + S3 content + S3 Vectors + Bedrock (single model call per node) + Lambda + SQS
- Start with ingestion Lambda: content in, single Bedrock call returns L0/L1/L2 as structured JSON, write to DynamoDB/S3
- Add SQS-driven parent rollup (bottom-up propagation matching OpenViking's DAG pattern)
- Add retrieval Lambda with parent_uri prefix filtering
- Package as CDK construct
- Security: IAM, VPC, KMS, Secrets Manager from day one
- No Step Functions — the model IS the pipeline

**Phase 4: Ship (Month 5+)**
- CDK construct published
- Optional: wrap as API service for consulting clients
- Blog the build ("How I rebuilt OpenViking's patterns on AWS")
- Evaluate whether to add Neptune for temporal knowledge graph

### Why not just build now?
- You don't yet know which OpenViking patterns matter most for your use cases
- Three months of operational experience with OpenViking will reveal design decisions you wouldn't anticipate
- The blog content from running OpenViking has immediate value
- The AWS-native build will be better because you understood the problem first

### Why not just run OpenViking forever?
- ByteDance dependency on an early-stage project
- No IAM integration, plaintext credentials, query-filter multi-tenancy
- Python monolith, not cloud-native scalable
- Cannot package as a service for consulting clients
- Security optics for a security-focused audience

---

## 6. Feasibility Summary

| OpenViking Concept | AWS Feasible? | Primary Service | Complexity | Risk |
|---|---|---|---|---|
| viking:// hierarchy | Yes | DynamoDB (PK/SK + GSI) | Low | Low |
| L0/L1/L2 tiers | Yes | Lambda + Bedrock (single model call per node) | Low | Low |
| Bottom-up rollup | Yes | SQS + Lambda (parent summariser) | Low | Low |
| Recursive retrieval | Yes | Lambda + OpenSearch/S3 Vectors | Medium | Medium (latency) |
| Session memory commit | Yes | Lambda + Bedrock (2 model calls) | Low | Low |
| Retrieval trajectory | Yes | CloudWatch + X-Ray | Low | Low |
| Multi-tenant scoping | Yes | DynamoDB PK + IAM | Low | Low |
| Content ingestion | Yes | Lambda + S3 + SQS | Low | Low |
| Multimodal support | Yes | Bedrock Claude (vision-capable) | Low | Low |

**Overall feasibility: HIGH.** All concepts map to AWS services with lower complexity than originally assessed. The key insight from reading OpenViking's source: the model does the heavy lifting, not a workflow engine. This simplifies the AWS implementation significantly. Lambda + SQS + Bedrock replaces what was originally proposed as Step Functions + Lambda + Bedrock. The highest-risk item remains retrieval latency when using S3 Vectors instead of OpenSearch Serverless.

---

## 7. Token Efficiency: The Real Value Proposition

OpenViking claims 83% token reduction on LoCoMo10 and 52% task completion vs 35% baseline. These numbers come from the hierarchical loading strategy:

- **Without tiers:** Agent loads full documents to assess relevance. 10 documents × 2,000 tokens = 20,000 tokens per query.
- **With L0 tiers:** Agent loads 10 abstracts × 100 tokens = 1,000 tokens. Drills to L2 on 1-2 relevant documents = 2,000-4,000 tokens. Total: 3,000-5,000 tokens. **75-85% reduction.**

This efficiency is **architecture-dependent, not implementation-dependent.** Any system implementing L0/L1/L2 tiers with hierarchical navigation would achieve similar savings. The AWS-native version would preserve this because the pattern is in the data model, not the code.

---

## 8. Service Viability Assessment

**Target audience:** Engineering teams building AI agents who need persistent, structured context management beyond flat conversation memory.

**Differentiation:** Only offering that combines hierarchical tiers (L0/L1/L2) with AWS-native security (IAM, VPC, KMS) and managed infrastructure.

**Packaging options:**
1. **CDK construct** (open-source): Fastest path. Users deploy in their own AWS account. Steve provides the architecture, community provides adoption.
2. **Managed API service** (SaaS): Higher revenue but requires multi-tenant infrastructure, billing, support. Significant operational burden for one person.
3. **Consulting engagement template**: Use the architecture as a repeatable consulting offering. Deploy customised versions for clients.

**Recommended: Start with CDK construct (option 1).** Lowest operational burden, highest content/credibility leverage, natural path to consulting engagements when teams want help deploying and customising.

---

## 9. Next Steps if Proceeding

1. **Immediate:** Continue OpenViking ECS deployment (blog posts ready)
2. **Week 1-4:** Run OpenViking with Steve's blog corpus, measure real token efficiency, document friction points
3. **Month 2:** Design AWS-native architecture, write architecture blog post
4. **Month 3:** Begin CDK construct for MVP (DynamoDB + S3 + S3 Vectors + Lambda + SQS + Bedrock)
5. **Month 4-5:** Add retrieval Lambda, query API, session commit handler
6. **Month 5+:** Publish CDK construct, write "how I rebuilt it" blog series
