# Viking Context Service - System Architecture

A hierarchical knowledge management system built on AWS serverless that ingests documents, generates multi-level summaries and embeddings, and provides AI-agent-native retrieval through MCP and REST APIs.

## Table of Contents

- [System Overview](#system-overview)
- [High-Level Architecture](#high-level-architecture)
- [The Three-Level Content Model](#the-three-level-content-model)
- [URI Namespace](#uri-namespace)
- [AWS Infrastructure](#aws-infrastructure)
- [Data Flow: Ingestion Pipeline](#data-flow-ingestion-pipeline)
- [Data Flow: Parent Rollup](#data-flow-parent-rollup)
- [Data Flow: Search and Retrieval](#data-flow-search-and-retrieval)
- [Data Flow: Session Management](#data-flow-session-management)
- [Data Flow: Memory Bridge](#data-flow-memory-bridge)
- [Data Flow: Knowledge Compiler](#data-flow-knowledge-compiler)
- [Browser Frontend (Viking Explorer)](#browser-frontend-viking-explorer)
- [CLI](#cli)
- [MCP Gateway Integration](#mcp-gateway-integration)
- [AI Model Strategy](#ai-model-strategy)
- [Observability](#observability)
- [Design Decisions](#design-decisions)

---

## System Overview

Viking Context Service (VCS) is a personal knowledge layer that sits between raw documents and AI agents. It solves a specific problem: AI agents need fast, relevant context, but full documents are too large and too slow to retrieve at query time.

VCS addresses this by maintaining a three-level content hierarchy (abstract, outline, full text) across a virtual filesystem. Documents are ingested once, summarised by LLMs, embedded as vectors, and organised into a navigable namespace. Agents retrieve only what they need at the detail level they need it.

The system also builds a wiki automatically. As documents are ingested, a knowledge compiler extracts entities and concepts, creates wiki pages, merges overlapping knowledge, and detects contradictions between sources.

```
                          +------------------+
                          |   AI Agents      |
                          |  (Claude, etc.)  |
                          +--------+---------+
                                   |
                    MCP Gateway    |   REST API
                   (AgentCore)     |   (API GW)
                          +--------+---------+
                          |                  |
                          |   Viking Context |
                          |     Service      |
                          |                  |
                          +--------+---------+
                                   |
              +--------------------+--------------------+
              |                    |                     |
        +-----+------+    +-------+-------+    +--------+--------+
        |  DynamoDB   |    |  S3 Content  |    |  S3 Vectors     |
        |  (L0 + L1)  |    |  (L2 full)   |    |  (embeddings)   |
        +-------------+    +--------------+    +-----------------+
```

---

## High-Level Architecture

```
+------------------------------------------------------------------------+
|                         CLIENTS                                         |
|   +------------+    +------------+    +-------------------+             |
|   | CLI (vcs)  |    | Browser    |    | MCP Agents        |             |
|   | 22 commands|    | (Explorer) |    | (Claude, Bedrock) |             |
|   +-----+------+    +-----+------+    +--------+----------+             |
|         |                  |                    |                        |
+---------|------------------|--------------------|-----------------------+
          |                  |                    |
          v                  v                    v
+------------------------------------------------------------------------+
|                     API GATEWAY (REST, v1)                               |
|   API Key auth | CORS | Throttle: 50 req/s | Quota: 10K/day            |
|                                                                          |
|   /fs/*          /resources   /search/*   /sessions/*   /compile        |
|   /vectors       /lint                                                   |
+-----+--------+--------+----------+-----------+--------+--------+-------+
      |        |        |          |           |        |        |
      v        v        v          v           v        v        v
+------------------------------------------------------------------------+
|                     LAMBDA FUNCTIONS (10)                                |
|                                                                          |
|   Filesystem   Ingestion   Query    Session   Parent-Summariser         |
|   Vectors      Compiler    Lint     Memory-Bridge   MCP-Tools           |
|                                                                          |
|   Runtime: Node.js 22 | Arch: ARM64 (Graviton) | Tracing: X-Ray        |
+-----+--------+--------+----------+-----------+--------+--------+-------+
      |        |        |          |           |        |        |
      v        v        v          v           v        v        v
+------------------------------------------------------------------------+
|                     STORAGE & PROCESSING                                |
|                                                                          |
|   +-------------+  +-------------+  +------------------+                |
|   | DynamoDB    |  | S3          |  | S3 Vectors       |                |
|   | - Context   |  | - Content   |  | - vcs-embeddings |                |
|   | - Sessions  |  | - Archives  |  | - 1024-dim       |                |
|   +-------------+  +-------------+  | - cosine         |                |
|                                      +------------------+                |
|   +-------------+  +-------------+  +------------------+                |
|   | SQS FIFO    |  | Bedrock     |  | AgentCore        |                |
|   | - Rollup    |  | - Nova M/L/P|  | - Memory         |                |
|   | - Compile   |  | - Titan Emb |  | - MCP Gateway    |                |
|   +-------------+  +-------------+  +------------------+                |
+------------------------------------------------------------------------+
```

---

## The Three-Level Content Model

Every document in VCS is stored at three levels of detail. This is the core design pattern that enables fast retrieval without sacrificing depth.

```
+-----------------------------------------------------------------------+
|                        CONTENT LEVELS                                  |
|                                                                        |
|   L0 (Abstract)         L1 (Outline)           L2 (Full Text)         |
|   +-----------------+   +------------------+   +------------------+   |
|   | 80-100 tokens   |   | Structured JSON  |   | Raw markdown     |   |
|   | Key conclusions |   | 3-8 sections     |   | stored in S3     |   |
|   | Stored inline   |   | with summaries   |   | referenced by    |   |
|   | in DynamoDB     |   | Stored inline    |   | s3_key field     |   |
|   |                 |   | in DynamoDB      |   |                  |   |
|   | Used for:       |   | Used for:        |   | Used for:        |   |
|   | - Search results|   | - Outline view   |   | - Deep reading   |   |
|   | - Parent rollup |   | - Topic scan     |   | - Full retrieval |   |
|   | - Embeddings    |   | - Quick review   |   | - Compilation    |   |
|   +-----------------+   +------------------+   +------------------+   |
|                                                                        |
|   DynamoDB: PK=uri, SK=level (0, 1, or 2)                             |
+-----------------------------------------------------------------------+
```

**Why three levels?** An agent asking "what do we know about DynamoDB?" doesn't need 50 full documents. It needs the abstracts (L0) to decide which documents are relevant, optionally the outlines (L1) for more detail, and only fetches the full text (L2) when it needs to read a specific document. This reduces token consumption by 10-100x compared to naive full-text retrieval.

---

## URI Namespace

All content is addressed via `viking://` URIs arranged in a hierarchical namespace:

```
viking://
  +-- resources/             Documents, guides, articles
  |     +-- feed/            Content ingested via 'vcs feed'
  |     +-- docs/            Manually ingested docs
  |
  +-- user/                  User-specific data
  |     +-- memories/        Extracted memories (6 categories)
  |           +-- profile/
  |           +-- preferences/
  |           +-- entities/
  |           +-- events/
  |           +-- cases/
  |           +-- patterns/
  |
  +-- agent/                 Agent skills and procedures
  |
  +-- session/               Session archives
  |     +-- {session-id}/    Individual session summaries
  |
  +-- wiki/                  Knowledge compilation output
  |     +-- entities/        Entity pages (services, tools, people)
  |     +-- concepts/        Concept pages (patterns, strategies)
  |     +-- synthesis/       User-authored synthesis pages
  |     +-- contradictions/  Auto-detected claim conflicts
  |
  +-- schema/                Schema definitions and templates
  |     +-- templates/       Wiki page templates
  |
  +-- log/                   System logs and compilation history
  |
  +-- compile/               Compilation job tracking
        +-- jobs/
        +-- budget/
```

**Directory nodes** (URIs ending with `/`) are virtual. They don't store content directly but aggregate their children's abstracts via the parent rollup pipeline.

---

## AWS Infrastructure

### Service Map

```
+------------------------------------------------------------------------+
|  Region: ap-southeast-2 (Sydney)                                        |
|                                                                          |
|  +---------------------------+    +---------------------------+          |
|  | API Gateway (REST)        |    | CloudFront                |          |
|  | Stage: v1                 |    | OAC -> S3 Explorer Bucket |          |
|  | API Key + Throttle        |    | SPA routing (403/404->/)  |          |
|  +----------+----------------+    +---------------------------+          |
|             |                                                            |
|  +----------v--------------------------------------------------+        |
|  |              LAMBDA FUNCTIONS (10, ARM64, Node 22)           |        |
|  |                                                               |        |
|  |  +----------+  +----------+  +----------+  +----------+     |        |
|  |  |Filesystem|  |Ingestion |  | Query    |  | Session  |     |        |
|  |  | 256MB    |  | 256MB    |  | 256MB    |  | 256MB    |     |        |
|  |  | 30s      |  | 60s      |  | 30s      |  | 120s     |     |        |
|  |  +----------+  +----------+  +----------+  +----------+     |        |
|  |                                                               |        |
|  |  +----------+  +----------+  +----------+  +----------+     |        |
|  |  |Parent    |  |Memory    |  |Compiler  |  | Lint     |     |        |
|  |  |Summariser|  |Bridge    |  | 512MB    |  | 256MB    |     |        |
|  |  | 256MB    |  | 256MB    |  | 180s     |  | 120s     |     |        |
|  |  | 60s      |  | 30s      |  +----------+  +----------+     |        |
|  |  +----------+  +----------+                                   |        |
|  |                                                               |        |
|  |  +----------+  +----------+                                   |        |
|  |  | Vectors  |  |MCP Tools |                                   |        |
|  |  | 256MB    |  | 256MB    |                                   |        |
|  |  | 30s      |  | 30s      |                                   |        |
|  |  +----------+  +----------+                                   |        |
|  +---------------------------------------------------------------+        |
|             |                                                            |
|  +----------v--------------------------------------------------+        |
|  |                    DATA STORES                                |        |
|  |                                                               |        |
|  |  DynamoDB (on-demand, PITR enabled)                           |        |
|  |  +---------------------+  +---------------------+            |        |
|  |  | Context Table       |  | Sessions Table      |            |        |
|  |  | PK: uri  SK: level  |  | PK: session_id      |            |        |
|  |  | GSI: parent-index   |  | SK: entry_type_seq  |            |        |
|  |  | GSI: type-index     |  | TTL: ttl            |            |        |
|  |  | GSI: category-index |  +---------------------+            |        |
|  |  +---------------------+                                      |        |
|  |                                                               |        |
|  |  S3                          S3 Vectors                       |        |
|  |  +---------------------+    +---------------------+          |        |
|  |  | Content Bucket      |    | Vectors Bucket      |          |        |
|  |  | - l2/ (full text)   |    | Index: vcs-embeddings|          |        |
|  |  | - archives/         |    | Dims: 1024          |          |        |
|  |  | - temp/             |    | Metric: cosine      |          |        |
|  |  | Versioned, logged   |    | float32             |          |        |
|  |  +---------------------+    +---------------------+          |        |
|  +---------------------------------------------------------------+        |
|             |                                                            |
|  +----------v--------------------------------------------------+        |
|  |                 ASYNC PROCESSING                              |        |
|  |                                                               |        |
|  |  SQS FIFO                   SNS                               |        |
|  |  +------------------+      +------------------+              |        |
|  |  | Rollup Queue     |      | Memory Payload   |              |        |
|  |  | -> Parent Summ.  |      | Topic            |              |        |
|  |  | DLQ: 3 retries   |      | -> Memory Bridge |              |        |
|  |  +------------------+      +------------------+              |        |
|  |  +------------------+                                         |        |
|  |  | Compile Queue    |      EventBridge                        |        |
|  |  | -> Compiler      |      +------------------+              |        |
|  |  | DLQ: 3 retries   |      | Weekly lint cron |              |        |
|  |  +------------------+      | Mon 00:00 UTC    |              |        |
|  +---------------------------------------------------------------+        |
|             |                                                            |
|  +----------v--------------------------------------------------+        |
|  |                 AI SERVICES                                   |        |
|  |                                                               |        |
|  |  Bedrock                    AgentCore                         |        |
|  |  +------------------+      +------------------+              |        |
|  |  | Nova Micro (fast)|      | Memory (vcs_mem) |              |        |
|  |  | Nova Lite (std)  |      | - Semantic       |              |        |
|  |  | Nova Pro  (pro)  |      | - Preferences    |              |        |
|  |  | Titan Embed V2   |      | - VCS Bridge     |              |        |
|  |  +------------------+      +------------------+              |        |
|  |                             +------------------+              |        |
|  |                             | MCP Gateway      |              |        |
|  |                             | OAuth 2.1 + PKCE |              |        |
|  |                             | 10 tool schemas  |              |        |
|  |                             +------------------+              |        |
|  +---------------------------------------------------------------+        |
+------------------------------------------------------------------------+
```

### DynamoDB Schema

**Context Table** stores all knowledge items:

| Attribute | Type | Role |
|-----------|------|------|
| `uri` | String | Partition key |
| `level` | Number | Sort key (0, 1, or 2) |
| `parent_uri` | String | GSI `parent-index` PK |
| `context_type` | String | GSI `type-index` PK |
| `category` | String | GSI `category-index` PK (memories only) |
| `content` | String | Inline content (L0/L1) |
| `s3_key` | String | S3 reference (L2 only) |
| `is_directory` | Boolean | Directory vs file |
| `processing_status` | String | `pending`, `processing`, `ready` |
| `created_at` | String | ISO timestamp |
| `updated_at` | String | ISO timestamp |

**Sessions Table** stores conversation state:

| Attribute | Type | Role |
|-----------|------|------|
| `session_id` | String | Partition key (UUID) |
| `entry_type_seq` | String | Sort key (`meta#0`, `msg#N`, `used#N`) |
| `role` | String | `user`, `assistant`, `system`, `tool` |
| `parts` | List | Structured message parts |
| `status` | String | `active`, `committed` |
| `msg_count` | Number | Atomic counter for sequencing |
| `ttl` | Number | Auto-delete after 30 days |

---

## Data Flow: Ingestion Pipeline

This is the core write path. Every document enters VCS through this pipeline.

```
  CLI: vcs feed <url>           CLI: vcs ingest <file>
  CLI: vcs remember <text>      Memory Bridge Lambda
           |                           |
           v                           v
  +-------------------------------------------+
  |         POST /resources                    |
  |         (Ingestion Lambda)                 |
  +-------------------------------------------+
           |
           v
  1. Acquire Processing Lock
     +-- Conditional write: processing_status -> 'processing'
     +-- Stale lock override after 5 minutes
           |
           v
  2. Store L2 Full Content
     +-- S3 PutObject: l2/{uri-path}
           |
           v
  3. Summarise via Bedrock
     +-- Estimate tokens (content.length / 4)
     +-- If < 200 tokens: use content as-is (skip LLM)
     +-- If < 115K tokens: Nova Lite
     +-- If < 270K tokens: escalate to Nova Pro
     +-- If > 270K tokens: reject with 413
     +-- Output: { abstract, sections[] }
           |
           v
  4. Atomic DynamoDB Write (TransactWriteItems)
     +-- L0: uri + level=0 + content=abstract
     +-- L1: uri + level=1 + content=JSON(sections)
     +-- L2: uri + level=2 + s3_key=key
           |
           v
  5. Generate Embedding
     +-- Text: abstract + section summaries
     +-- Model: Titan Embed V2 (1024 dimensions)
     +-- Truncate to 30K chars if needed
           |
           v
  6. Store Vector (S3 Vectors)
     +-- Key: uri
     +-- Metadata: uri, parent_uri, context_type, level
     +-- Overwrites existing vector
           |
           v
  7. Await ANN Index Visibility
     +-- Poll with exponential backoff (100ms base, 5 attempts)
     +-- Non-blocking: logs warning if not visible yet
           |
           v
  8. Enqueue Parent Rollup (SQS FIFO)
     +-- Message: { parentUri }
     +-- 5-min dedup window prevents rollup storms
           |
           v
  9. Enqueue Compilation (SQS FIFO)
     +-- Triggers wiki page extraction
     +-- Budget-capped (500 Nova Pro calls/day)
```

**Retry policy:** 3 attempts with exponential backoff (1s, 2s, 4s) for transient errors (throttling, 5xx). Non-retryable errors release the processing lock immediately.

---

## Data Flow: Parent Rollup

After any document is written, its parent directory's summary is regenerated. This creates a hierarchical aggregation chain.

```
  SQS FIFO: Rollup Queue
  (Parent Summariser Lambda, batchSize=1, maxConcurrency=2)
           |
           v
  1. Query Ready Children
     +-- GSI parent-index: parent_uri = X, level = 0
     +-- Filter: processing_status = 'ready'
     +-- Collect all child L0 abstracts
           |
           v
  2. Synthesise Parent Abstract
     +-- Format: "- {child_uri}: {abstract}\n" for each child
     +-- Model: Nova Micro (fast, cheap)
     +-- Output: { abstract, sections[] }
           |
           v
  3. Write Parent L0 + L1
     +-- is_directory = true
     +-- processing_status = 'ready'
           |
           v
  4. Update Parent Vector
     +-- Delete old vector, put new
     +-- Embedding from abstract + section summaries
           |
           v
  5. Propagate to Grandparent
     +-- If grandparent exists and is not root
     +-- Enqueue grandparent URI for rollup
     +-- Creates recursive aggregation chain

  Example chain:
  viking://resources/feed/aws-waf.md  (document written)
      -> viking://resources/feed/     (parent rolled up)
      -> viking://resources/          (grandparent rolled up)
      -> viking://                    (root - stop)
```

---

## Data Flow: Search and Retrieval

### Stateless Search (`POST /search/find`)

Single-query search with drill-down for precision.

```
  Query: "How does DynamoDB single-table design work?"
           |
           v
  1. Generate Query Embedding (Titan V2)
           |
           v
  2. Global ANN Search (S3 Vectors, topK=10)
     +-- Returns: [{uri, distance, abstract}, ...]
           |
           v
  3. Score-Blended Drill-Down (up to 5 depths)
     +-- For each directory result:
     |     Query children with parent_uri filter
     |     blendedScore = 0.5 * similarity + 0.5 * parent_score
     +-- Convergence: stop when top-5 results unchanged for 3 rounds
           |
           v
  4. Filter by min_score + scope, limit to max_results
           |
           v
  Return: { results[], trajectory[], tokens_saved_estimate }
```

### Session-Aware Search (`POST /search/search`)

Decomposes queries using session context for multi-source retrieval.

```
  Query: "What memory strategies have we discussed?"
  Session: {id}
           |
           v
  1. Load Session Context
     +-- Read meta#0 compression_summary
     +-- Read last 5 messages
           |
           v
  2. Intent Analysis (Nova Micro)
     +-- Input: query + session_summary + recent_messages
     +-- Output: sub-queries with context_type routing
     +-- Example: [
     |     { query: "memory strategies", context_type: "resource" },
     |     { query: "user memory preferences", context_type: "memory" }
     |   ]
     +-- Chitchat detection: returns empty queries
           |
           v
  3. Route Sub-Queries (parallel)
     +-- Memory queries -> AgentCore RetrieveMemoryRecords
     +-- Non-memory queries -> S3 Vectors drill-down
           |
           v
  4. Merge and Group
     +-- Deduplicate across sources (highest score wins)
     +-- Group by: memories[], resources[], skills[]
           |
           v
  Return: { memories[], resources[], skills[],
            query_plan, trajectory, tokens_saved }
```

---

## Data Flow: Session Management

Sessions track conversations between AI agents and VCS.

```
  1. CREATE SESSION
     POST /sessions -> { session_id }
     +-- DynamoDB: meta#0 entry, status='active', msg_count=0

  2. ADD MESSAGES (repeats)
     POST /sessions/{id}/messages { role, parts[] }
     +-- Atomic increment msg_count for sequence
     +-- Write: msg#{seq} entry
     +-- Fire-and-forget: AgentCore CreateEvent (dual-write)

  3. RECORD USAGE
     POST /sessions/{id}/used { uris[] }
     +-- Increment active_count on referenced URIs
     +-- Write: used#{seq} entry

  4. COMMIT SESSION
     POST /sessions/{id}/commit
           |
           v
     Phase 1: Summarise
     +-- Read all messages
     +-- Bedrock summarisation -> { one_line, analysis,
     |                              key_concepts, pending_tasks }
     +-- Archive to S3: messages.json + summary.json
           |
           v
     Phase 2: Persist
     +-- Write session L0/L1 to viking://session/{id}/
     +-- Generate embedding, store vector
           |
           v
     Phase 3: Finalize
     +-- Update status to 'committed'
     +-- Set 30-day TTL on all session items
     +-- Enqueue rollup for viking://session/
           |
           v
     Async: AgentCore Memory Extraction
     +-- Triggered by message count threshold (6+)
     +-- AgentCore extracts memories -> SNS -> Memory Bridge
```

---

## Data Flow: Memory Bridge

Connects AgentCore's memory extraction to the VCS knowledge layer.

```
  AgentCore Memory Extraction Job
  (triggered by session message accumulation)
           |
           v
  SNS: Memory Payload Topic
           |
           v
  Memory Bridge Lambda
           |
           v
  For each extracted context entry:
           |
           v
  1. Classify (Nova Micro)
     +-- Input: "{role}: {text}"
     +-- Output: { category, content, confidence }
     +-- Skip if confidence < 0.5
     +-- Categories: profile, preferences, entities,
     |               events, cases, patterns
           |
           v
  2. Generate Embedding (Titan V2)
           |
           v
  3. Dedup Check
     +-- Search S3 Vectors: same category, cosine < 0.2
     +-- If match found:
     |     LLM decides: skip | create | merge | delete
     |     (Nova Micro with existing + new content)
           |
           v
  4. Write Memory
     +-- URI: viking://user/memories/{category}/{timestamp}-{id}
     +-- L0 content, vector, processing_status='ready'
           |
           v
  5. Enqueue for Compilation
     +-- Memory content feeds wiki knowledge extraction
```

---

## Data Flow: Knowledge Compiler

Automatically builds and maintains a wiki from ingested documents and memories.

```
  SQS FIFO: Compile Queue
  (Compiler Lambda, 512MB, 180s timeout)
           |
           v
  1. Read Source Content
     +-- Try L1 (summarised) first, fall back to L0
           |
           v
  2. Extract Entities & Concepts (Nova Lite, tool-use)
     +-- Tool: EntityExtractionTool
     +-- Output: {
     |     entities: [{ name, type, description }],
     |     concepts: [{ name, description }]
     |   }
     +-- Filter: description >= 20 chars
     +-- Deduplicate by lowercase name
           |
           v
  3. For Each Entity/Concept:
           |
     +-----+------+
     |             |
     v             v
  EXISTS?        NEW?
  (vector         |
   search)        v
     |        Create Page (Nova Pro)
     v        +-- buildEntityCreatePrompt()
  Merge Page  +-- Generate frontmatter (code, not LLM)
  (Nova Pro)  +-- Write via writeDocument()
  +-- buildMergePrompt()
  +-- Detect contradictions in merged content
  +-- Preserve Human Notes section
  +-- Normalise citations
           |
           v
  4. Validate Contradictions (three-gate)
     +-- Gate 1: LLM extraction (from merge response)
     +-- Gate 2: Semantic similarity (Titan embedding)
     |     Discard if cosine similarity > 0.75 (restatement)
     +-- Gate 3: Subset/elaboration check (stopword-filtered)
     |     Discard if word overlap > 70%
           |
           v
  5. Create Contradiction Pages
     +-- viking://wiki/contradictions/{slug}-{timestamp}.md
     +-- Contains: Claim A, Claim B, source attribution, analysis
           |
           v
  6. Update Wiki Index + Compilation Log
     +-- Budget tracking: max 500 Nova Pro calls/day
```

---

## Browser Frontend (Viking Explorer)

A React SPA served via CloudFront that provides visual exploration of the VCS namespace.

```
  +-----------------------------------------------------------------------+
  |  Viking Explorer                                    Connected  Search  |
  +---+----------+--------+----------+--------+--------------------------+
  |   | Dashboard | Navigator | Map | Timeline | Wiki |                   |
  +---+----------+-----------+-----+----------+------+-------------------+

  Dashboard:     4 cards showing namespace counts (resources, memories,
                 skills, sessions)

  Navigator:     Three-pane hierarchical browser
                 +-- Left:   Tree view (expandable namespace)
                 +-- Middle: Entry list (filtered by scope)
                 +-- Right:  Entry detail (L0/L1/L2 tabs)

  Map:           2D embedding visualization using UMAP projection
                 +-- D3 zoom/pan on canvas
                 +-- Scope filtering (resource, memory, skill, session)

  Timeline:      Session history and memory distribution
                 +-- Session nodes with summaries
                 +-- Memory category breakdown chart

  Wiki:          Knowledge graph browser
                 +-- List mode: filterable sidebar by category
                 +-- Graph mode: force-directed graph with edges
                 +-- Detail view: rendered markdown with [[wikilinks]]
```

**Tech stack:** React 19, React Router v7, TanStack React Query, shadcn/ui, Tailwind CSS v4, Recharts, react-force-graph-2d, UMAP.

**API client:** `createApi(credentials)` factory with methods: `ls`, `lsAll`, `tree`, `read`, `find`, `vectors`, `health`. Authentication via `x-api-key` header with credentials stored in localStorage.

---

## CLI

The `vcs` CLI provides full CRUD operations on the VCS namespace. Built with Bun and Commander.js.

### Commands

| Command | Description |
|---------|-------------|
| `vcs health` | Check API connectivity and latency |
| `vcs config init` | Interactive setup (URL + API key) |
| `vcs config show` | Display config (API key masked) |
| `vcs find <query>` | Stateless semantic search |
| `vcs search <query>` | Session-aware search |
| `vcs read <uri>` | Read content at level 0/1/2 |
| `vcs ls <uri>` | List directory children |
| `vcs tree <uri>` | Recursive namespace tree |
| `vcs ingest <path>` | Ingest file, directory, or stdin |
| `vcs feed <source>` | Extract and ingest URL or file (HTML/PDF/Markdown) |
| `vcs remember <text>` | Store a memory with category |
| `vcs session create` | Create conversation session |
| `vcs session message` | Add message to session |
| `vcs session used` | Record URI usage |
| `vcs session commit` | Archive and extract memories |
| `vcs session delete` | Remove session |
| `vcs compile <uri>` | Compile source into wiki pages |
| `vcs mkdir <uri>` | Create directory node |
| `vcs rm <uri>` | Remove node (cascade) |
| `vcs mv <src> <dst>` | Move/rename node |
| `vcs status` | Show instance status |
| `vcs lint` | Run wiki health check |

**Configuration:** `~/.vcs/config.json` or `VCS_API_URL` / `VCS_API_KEY` environment variables. All commands support `--json` for machine-readable output.

---

## MCP Gateway Integration

VCS exposes itself as an MCP tool server through AWS Bedrock AgentCore Gateway.

```
  AI Agent (Claude, etc.)
       |
       v
  AgentCore MCP Gateway
  +-- Protocol: MCP 2025-03-26
  +-- Auth: OAuth 2.1 + PKCE (Cognito)
  +-- Discovery: RFC 9728
       |
       v
  MCP Tool Executor Lambda
  +-- Dispatches to VCS REST API
  +-- 10 registered tools:
       |
       +-- read       Read content at detail level
       +-- ls         List directory children
       +-- tree       Recursive directory tree
       +-- find       Stateless semantic search
       +-- search     Session-aware search
       +-- ingest     Ingest markdown documents
       +-- create_session
       +-- add_message
       +-- used       Record consulted URIs
       +-- commit_session
```

---

## AI Model Strategy

VCS uses a tiered model approach to balance cost and capability:

| Tier | Model | Context | Cost (input/1M) | Used For |
|------|-------|---------|------------------|----------|
| Fast | Nova Micro | 128K | $0.035 | Intent analysis, memory classification, dedup, parent rollup |
| Standard | Nova Lite | 128K | $0.06 | Document summarisation, entity extraction, lint analysis |
| Pro | Nova Pro | 300K | $0.30 | Wiki page creation/merge, contradiction detection |
| Embedding | Titan Embed V2 | 8K | $0.02 | 1024-dim vector generation |

**Model escalation:** When content exceeds a model's token limit, the system automatically escalates to the next tier (Lite -> Pro). Content beyond Pro's 300K limit returns a 413 error.

**Cross-region inference:** Amazon models use no prefix. Anthropic models (Haiku) use `us.*` for US regions, `global.*` for others.

---

## Observability

### CloudWatch Dashboard (6 rows)

| Row | Widgets |
|-----|---------|
| Lambda Health | Errors (8 functions), Duration (P50/P99), Invocations |
| Ingestion & Retrieval | Ingestion rate, Retrieval latency (P50/P90/P99), DynamoDB capacity |
| Infrastructure | SQS queue depths, DLQ message counts |
| Bedrock | Invocations by model, Latency, Token counts, Errors + Throttles |
| Memory Bridge | Invocations, Latency (P50/P99), DLQ depth |
| Knowledge Compiler | Compiler activity, Duration (P50/P99) |

### Alarms

| Alarm | Condition | Severity |
|-------|-----------|----------|
| DLQ depth (rollup, bridge, compile) | Messages > 0 | Critical |
| Lambda errors (8 functions) | Errors > 0 in 5 min | High |
| Ingestion P99 latency | > 30s (3 periods) | Medium |
| Retrieval P99 latency | > 2s (3 periods) | Medium |
| Bedrock daily cost | > $5/day | Medium |
| Bedrock errors/throttles | > 0 | High |

### Synthetic Monitoring (CloudWatch Canaries)

| Canary | Schedule | Tests |
|--------|----------|-------|
| Health | Every 5 min | Basic endpoint health |
| ISR | Every 15 min | Ingest-summarise-retrieve workflow |
| Session | Every 30 min | Full session lifecycle |

### Evaluation Suite (CodeBuild)

Nightly at 02:00 AEST: functional and performance test suites via k6.

---

## Design Decisions

### Service Selection

#### DynamoDB — Primary Context Store

**Chosen over:** Aurora PostgreSQL, DocumentDB

DynamoDB provides single-digit millisecond latency with on-demand pricing, which suits the hierarchical document-oriented access patterns of VCS. The primary key design (`PK=uri, SK=level`) maps directly to the three-level content model, enabling single-item lookups for any document at any detail level. Three GSIs support the navigation patterns: `parent-index` for directory listing (`ls`), `type-index` for scoped queries, and `category-index` for memory browsing.

Relational databases were rejected because VCS never performs joins — every operation is a single-key lookup, a parent-child scan, or a batch write. Aurora's minimum cost (~$60/month for a db.t4g.medium) is disproportionate for a personal knowledge base that processes dozens of documents, not millions of transactions.

On-demand billing was chosen for the POC stage. At scale (10x current load), the design accommodates a switch to provisioned capacity with auto-scaling.

#### S3 — L2 Full Content and Session Archives

**Chosen over:** DynamoDB inline storage, EFS

L2 full-text content is stored in S3 rather than DynamoDB because DynamoDB items are capped at 400KB. A single PDF extraction can produce megabytes of text. S3 has no item size limit, costs ~$0.023/GB/month, and supports versioning for content history.

L2 content is write-once — it's never updated, only replaced via re-ingestion. This immutability model aligns with S3's strengths. Versioning is enabled to allow rollback. A lifecycle rule expires non-current versions after 30 days to control costs.

Session archives (messages and summaries) also go to S3 under `archives/{sessionId}/` for the same reasons: unbounded size, low cost, and write-once semantics.

EFS was considered for Lambda-attached persistent storage but rejected — no Lambda in VCS needs shared mutable state, and EFS requires VPC attachment (which adds cold start latency).

#### S3 Vectors — Embedding Storage and ANN Search

**Chosen over:** OpenSearch Serverless, Pinecone, pgvector

S3 Vectors costs $0.06/GB/month compared to OpenSearch Serverless's minimum of ~$175/month (2 OCUs). For a personal knowledge base with hundreds of documents, the cost difference is decisive.

S3 Vectors integrates natively with IAM, S3 encryption, and the existing AWS stack. It supports metadata filtering on insert-time fields (`uri`, `parent_uri`, `context_type`, `level`), which enables scoped searches without post-filtering.

The trade-off is latency: S3 Vectors ANN queries have 100ms+ cold starts compared to OpenSearch's ~10ms. The system handles this with visibility polling (5 attempts, 100ms exponential backoff) after writes, and accepts that newly indexed content may take a few seconds to appear in search results.

The vector index schema is **immutable after creation** — metadata fields and dimensions cannot be changed without rebuilding the index. This was an intentional constraint accepted during design: the schema (`uri`, `parent_uri`, `context_type`, `level`, `abstract`, `created_at`) covers all current and foreseeable filtering needs.

A documented migration path to OpenSearch exists if P90 query latency exceeds 500ms sustained.

Pinecone was rejected to avoid vendor lock-in outside the AWS ecosystem. pgvector (via Aurora) was rejected because it would reintroduce the Aurora cost overhead for a single use case.

#### SQS FIFO — Async Processing Queues

**Chosen over:** Step Functions, EventBridge Pipes, direct Lambda invocation

Two FIFO queues drive async processing: the rollup queue (parent summarisation) and the compile queue (wiki generation).

FIFO ordering prevents race conditions during bulk ingestion — when 50 documents are ingested into the same directory, the parent rollup processes them in order rather than concurrently overwriting the parent summary. Content-based deduplication with a 5-minute window prevents rollup storms: 50 rapid writes to the same parent trigger one rollup, not 50.

Step Functions were considered for the compilation pipeline but rejected as over-engineered for the current workload. The compile queue uses FIFO with `MessageGroupId='compile-all'` to serialise compilation jobs, which is sufficient. If VCS scales to handle concurrent compilation across many source documents, Step Functions may be reconsidered.

Dead letter queues (3 retries) catch transient failures without blocking the main queue. DLQ depth > 0 triggers a critical alarm.

#### Lambda — Compute Layer (10 Functions)

**Chosen over:** ECS Fargate, EC2, App Runner

Lambda's stateless request-response model fits VCS's architecture: each API call is independent, each SQS message processes one item, and no function needs persistent state.

Key configuration decisions:

- **ARM64 (Graviton):** 20% cheaper than x86 with comparable or better performance for Node.js workloads.
- **No VPC attachment:** None of VCS's data stores (DynamoDB, S3, S3 Vectors, Bedrock) require VPC access. Avoiding VPC eliminates the 5-10 second cold start penalty from ENI attachment.
- **Individual IAM roles per function:** Each Lambda gets only the permissions it needs. The Query Lambda has read-only DynamoDB access; the Ingestion Lambda has read/write. A monolith function would require the union of all permissions.
- **Tuned memory and timeouts:** The Compiler Lambda gets 512MB and 180s (it holds full wiki pages in memory during merge). The Query Lambda gets 256MB and 30s (it runs a single vector search). A monolith would need the highest allocation for every invocation.

ECS was rejected because the workload is bursty (API requests) rather than sustained, and Lambda's per-request pricing beats Fargate's per-second billing for low-to-moderate traffic.

#### API Gateway (REST) — External API

**Chosen over:** HTTP API, ALB, direct Lambda URLs

REST API Gateway was chosen for its built-in API key management, request throttling (50 req/s rate, 100 burst, 10K daily quota), and structured access logging. These features would need custom implementation with HTTP API or Lambda URLs.

CORS is configured for local development (`localhost:3000`, `localhost:5173`) and the production CloudFront domains. API key authentication is required on all routes — simple to implement, low overhead, and sufficient for a single-tenant system.

HTTP API (v2) was considered for its lower latency and cost, but lacks the native API key and usage plan features that REST API provides out of the box.

#### CloudFront + S3 — Browser Frontend Hosting

**Chosen over:** Amplify Hosting, S3 website hosting

CloudFront with Origin Access Control (OAC) serves the Viking Explorer SPA from a private S3 bucket. The SPA routing is handled by configuring 403/404 error responses to return `index.html` with a 200 status, enabling client-side routing without server-side configuration.

The bucket blocks all public access — only CloudFront can read from it via OAC. This is more secure than S3 static website hosting, which requires public bucket policies.

Amplify was considered but rejected as unnecessary for a pre-built SPA that just needs static hosting with cache invalidation.

#### Bedrock — AI Model Access

**Chosen over:** Self-hosted models, OpenAI API, direct Anthropic API

Bedrock provides managed access to multiple model families (Nova, Claude, Titan) with IAM-native authentication, no API key management, and automatic scaling. It integrates cleanly with the existing AWS infrastructure — Lambda functions call Bedrock via the AWS SDK with IAM roles, not API keys.

VCS uses a tiered model strategy to balance cost and capability:

- **Nova Micro ($0.035/1M input tokens):** Used for fast, simple tasks — intent analysis, memory classification, dedup decisions, parent rollup. These tasks process small inputs (<2K tokens) and need low latency, not deep reasoning.
- **Nova Lite ($0.06/1M):** Used for standard summarisation and entity extraction. Sufficient quality for factual summarisation at 50% the cost of Nova Pro.
- **Nova Pro ($0.30/1M):** Used for complex tasks requiring large context — wiki page creation/merge (which processes existing page + source document + template), contradiction analysis. Its 300K token context window handles the largest documents.
- **Titan Embed V2 ($0.02/1M):** 1024-dimensional embeddings optimised for cosine similarity search. Chosen for its native S3 Vectors compatibility and low cost.

Claude Haiku was the original summarisation model but was replaced with Nova Lite after testing showed comparable quality at lower cost for factual summarisation tasks. Claude remains available for complex reasoning if needed (the model resolution function supports cross-region inference profiles for Anthropic models).

The model escalation pattern — Nova Lite for most content, automatic upgrade to Nova Pro when token estimates exceed the model's context window — was added after the AWS Well-Architected Framework PDF (200+ pages) exceeded Nova Lite's 128K token limit. Documents beyond Nova Pro's 300K limit return a 413 error rather than a cryptic Bedrock exception.

#### AgentCore — Memory and MCP Gateway

**Chosen over:** Custom memory implementation, custom MCP server

AgentCore Memory provides three extraction strategies out of the box:
- **Semantic:** Built-in semantic memory extraction
- **User Preference:** Built-in preference tracking
- **VCS Bridge (Custom):** Self-managed strategy that routes extracted memories back into VCS

The custom Bridge strategy is key: it triggers when sessions accumulate 6+ messages, extracts memory candidates, and delivers them via S3 + SNS to the Memory Bridge Lambda. This creates a feedback loop — conversations produce memories, memories feed wiki compilation, compiled wiki pages improve future search results.

Building custom memory extraction would have required implementing the extraction triggers, payload management, and strategy orchestration that AgentCore provides natively.

The AgentCore MCP Gateway exposes VCS as a tool server for MCP-compatible agents (Claude Code, Cursor, etc.) using OAuth 2.1 with PKCE and automatic Cognito provisioning. 10 tool schemas are registered, covering the full VCS API surface. The MCP Tool Executor Lambda translates MCP tool calls to REST API calls — it doesn't import service modules directly, maintaining clean separation between the MCP protocol layer and the business logic.

#### EventBridge — Scheduled Lint

**Chosen over:** CloudWatch Events (legacy), external cron

EventBridge triggers the Lint Lambda weekly (Monday 00:00 UTC) to scan all wiki pages for quality issues — orphaned pages, stale references, missing cross-links, and unresolved contradictions. EventBridge was chosen over CloudWatch Events for its newer API and better CDK integration. No external cron service needed.

#### CloudWatch + X-Ray — Observability

**Chosen over:** Datadog, Grafana Cloud

CloudWatch provides native integration with all AWS services used by VCS. The custom dashboard tracks 6 dimensions: Lambda health, ingestion/retrieval performance, infrastructure (queue depths), Bedrock usage (invocations/latency/tokens/cost), Memory Bridge activity, and Knowledge Compiler throughput.

X-Ray tracing is active on all Lambda functions via Powertools Tracer, providing request-level visibility without additional instrumentation infrastructure.

CloudWatch Synthetics (Canaries) run three automated tests: health check (5 min), ingest-summarise-retrieve workflow (15 min), and full session lifecycle (30 min). These catch integration failures before users do.

A CodeBuild evaluation suite runs nightly at 02:00 AEST with functional and performance tests via k6, producing JUnit reports for trend analysis.

Datadog and Grafana Cloud were considered but rejected for a single-tenant personal project — the additional monthly cost and integration overhead don't justify the benefits over native CloudWatch.

---

### Architectural Patterns

#### Three-Level Content Model (L0/L1/L2)

The core design pattern. Every document is stored at three levels of detail:

- **L0 (~100 tokens):** Abstract capturing conclusions, not just topic. Stored inline in DynamoDB.
- **L1 (~2K tokens):** Structured JSON sections with summaries. Stored inline in DynamoDB.
- **L2 (unbounded):** Full raw content. Stored in S3, referenced by `s3_key`.

A single Bedrock call generates both L0 and L1 — the summarisation prompt returns `{ abstract, sections[] }` in one response. This is cheaper than separate calls and maintains consistency between the abstract and section summaries.

**Why not two levels?** Two tiers (abstract + full) lose the structured navigation that L1 provides. An agent scanning L1 section titles can pinpoint exactly which section to load at L2, without reading the entire document.

**Why not one level?** Full-text retrieval for 20 documents at L2 might consume 40K tokens. The same search at L0 uses ~2K tokens — a 20x reduction. The three-level model gives agents explicit control over their token budget.

#### Hierarchical Namespace with Parent Rollup

The `viking://` URI hierarchy isn't just an addressing scheme — it drives the rollup aggregation pattern. When a document is written, its parent directory's summary is regenerated from all children's L0 abstracts. This propagates upward: the grandparent's summary incorporates the updated parent, and so on to root.

The result is that every directory node has an up-to-date abstract summarising its contents. An agent searching at the directory level gets a coherent overview without reading every child document.

**Why not flat tags?** A flat namespace with tags would support filtering but not hierarchical aggregation. The parent rollup pattern requires a tree structure to propagate summaries bottom-up.

#### Score-Blended Drill-Down Retrieval

Search uses a recursive drill-down algorithm rather than flat vector search:

`blendedScore = 0.5 * embedding_similarity + 0.5 * parent_score`

Equal weight to individual relevance (embedding match) and directory context (parent proximity). This means documents in a highly relevant directory score higher than isolated documents with the same embedding similarity.

The algorithm converges when the top-5 results are unchanged for 3 consecutive rounds, or after a maximum of 5 rounds. This prevents unnecessary API calls while ensuring thorough exploration.

**Why not flat search?** Flat vector search returns results mixed across all hierarchy levels — a directory abstract might outrank its more relevant child document. Drill-down respects the tree structure and navigates into promising directories.

#### Index-First Consistency

Delete operations follow a strict ordering: vectors first, then DynamoDB, then S3. This ensures that a deleted document is immediately removed from search results, even if the DynamoDB/S3 cleanup fails partway through.

The principle: a **missing result** (vector deleted, source still exists) is acceptable degradation. A **stale result** (vector exists, source deleted) returns invalid URIs and breaks the agent's workflow. Better to miss a result than return a wrong one.

Move operations use a copy-update-delete pattern that is idempotent and resumable — partial failure leaves both old and new copies, and retry completes the operation.

#### Processing Locks with Stale Override

The `processing_status` field on DynamoDB items acts as a lightweight distributed lock. When a document is being ingested, the status is set to `processing` via a conditional update. Other write attempts are rejected with a 409 Conflict.

A stale lock override kicks in after 5 minutes — if a Lambda times out or crashes mid-write, the lock is automatically released on the next write attempt. This avoids permanent lock-out without requiring an external lock manager.

#### Fire-and-Forget Async Integration

AgentCore dual-writes (session messages -> CreateEvent) are non-blocking. If the AgentCore call fails, the session message is still recorded in DynamoDB. Memory extraction happens asynchronously via AgentCore's self-managed strategy — VCS doesn't poll or wait for extraction results.

This pattern keeps API latency predictable (session message writes complete in <100ms) while enabling complex downstream processing (memory extraction, classification, dedup) to happen at its own pace.

---

### Alternatives Considered

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| Primary database | DynamoDB (on-demand) | Aurora PostgreSQL | No joins needed; hierarchical key design; lower cost for sparse traffic |
| L2 storage | S3 | DynamoDB inline | 400KB item limit too small for full documents; S3 is unbounded and cheap |
| Vector search | S3 Vectors | OpenSearch Serverless | $0.06/GB vs $175/month minimum; latency acceptable for personal use |
| Vector search | S3 Vectors | Pinecone | Avoids vendor lock-in outside AWS; native IAM integration |
| Summarisation model | Nova Lite | Claude Haiku | Comparable quality for factual summarisation at lower cost |
| Summarisation model | Nova Lite | Claude Opus | 8x cost; complex reasoning not needed for summarisation |
| Rollup orchestration | SQS FIFO | Step Functions | Native deduplication; simpler; cheaper for the current scale |
| Compute | Lambda (ARM64, no VPC) | ECS Fargate | Per-request billing; no cold start penalty without VPC |
| API layer | REST API Gateway | HTTP API (v2) | API key management and usage plans built-in |
| Frontend hosting | CloudFront + S3 (OAC) | Amplify Hosting | Simpler; no build pipeline needed for pre-built SPA |
| Memory system | AgentCore (custom bridge) | Custom extraction pipeline | Built-in strategies + self-managed extensibility |
| MCP transport | StreamableHTTP via Lambda | Stdio transport | HTTP works serverless; stdio requires long-lived processes |
| Observability | CloudWatch + X-Ray | Datadog | Native integration; no additional cost for single-tenant |
| Auth (API) | API key | JWT/OAuth | Simple for single-tenant; sufficient for external agents |
| Auth (MCP) | OAuth 2.1 + PKCE | API key | AgentCore requires OAuth; PKCE provides secure public client flow |
