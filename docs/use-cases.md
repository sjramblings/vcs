# Viking Context Service - Use Cases Walkthrough

Practical walkthroughs showing how VCS handles real-world scenarios, from ingesting a PDF to browsing a self-building wiki. Each use case traces the full path through the system.

## Table of Contents

- [Use Case 1: Ingesting a Large Document](#use-case-1-ingesting-a-large-document)
- [Use Case 2: Browsing the Knowledge Wiki](#use-case-2-browsing-the-knowledge-wiki)
- [Use Case 3: Semantic Search from an AI Agent](#use-case-3-semantic-search-from-an-ai-agent)
- [Use Case 4: Session-Aware Conversation Retrieval](#use-case-4-session-aware-conversation-retrieval)
- [Use Case 5: Memory Extraction from Conversations](#use-case-5-memory-extraction-from-conversations)
- [Use Case 6: Knowledge Compilation - From Document to Wiki](#use-case-6-knowledge-compilation---from-document-to-wiki)
- [Use Case 7: Contradiction Detection](#use-case-7-contradiction-detection)
- [Use Case 8: Navigating the Namespace](#use-case-8-navigating-the-namespace)
- [Use Case 9: Embedding Map Exploration](#use-case-9-embedding-map-exploration)
- [Use Case 10: Wiki Graph Relationships](#use-case-10-wiki-graph-relationships)

---

## Use Case 1: Ingesting a Large Document

**Scenario:** You have a 200-page PDF (the AWS Well-Architected Framework) and want it indexed in your knowledge base.

### Step 1: Feed the document

```bash
vcs feed ~/Downloads/aws-wellarchitected-framework.pdf
```

The CLI detects the `.pdf` extension and uses `unpdf` to extract the full text. It derives a filename (`aws-wellarchitected-framework.md`), wraps the text with a title header and source attribution, then base64-encodes the content and POSTs it to the VCS API.

### Step 2: What happens server-side

The ingestion Lambda receives the content and enters the write pipeline:

```
Content received (~150K tokens estimated)
    |
    v
Acquire processing lock on
  viking://resources/feed/aws-wellarchitected-framework.md
    |
    v
Store full text in S3
  Key: l2/resources/feed/aws-wellarchitected-framework.md
    |
    v
Estimate tokens: 150K > Nova Lite's 115K safe limit
  -> Escalate to Nova Pro (300K limit)
    |
    v
Nova Pro summarises the document:
  L0 abstract: "The AWS Well-Architected Framework defines best
  practices across six pillars: operational excellence, security,
  reliability, performance efficiency, cost optimization, and
  sustainability. Recommends regular workload reviews against
  these pillars using the Well-Architected Tool."

  L1 sections: [
    { title: "Operational Excellence", summary: "..." },
    { title: "Security Pillar", summary: "..." },
    { title: "Reliability", summary: "..." },
    ...6 more sections
  ]
    |
    v
Atomic write to DynamoDB:
  L0 (uri, level=0, content=abstract)
  L1 (uri, level=1, content=JSON(sections))
  L2 (uri, level=2, s3_key=l2/resources/feed/...)
    |
    v
Generate 1024-dim embedding from abstract + section summaries
  -> Titan Embed V2
  -> Truncate input to 30K chars if needed
    |
    v
Store vector in S3 Vectors index
  -> Poll for ANN visibility (5 attempts, 100ms backoff)
    |
    v
Enqueue parent rollup: viking://resources/feed/
Enqueue compilation: wiki entity/concept extraction
```

### Step 3: The ripple effect

After the document is stored, two async processes trigger:

**Parent rollup:** The `viking://resources/feed/` directory gets a new aggregate summary that includes this document's abstract alongside all other feed documents. That rollup propagates up to `viking://resources/` and then stops at root.

**Compilation:** The compiler reads the document's L1 content and extracts entities (e.g., "AWS Well-Architected Tool", "Security Pillar") and concepts (e.g., "Shared Responsibility Model", "Least Privilege"). Each one becomes a wiki page or merges into an existing one.

### What if the document is too large?

If the extracted text exceeds Nova Pro's 300K token limit (~1.2M characters), the pipeline returns a clear 413 error:

```
Content too large for any available model: ~320K tokens estimated
(max 270K). Consider chunking the document before ingestion.
```

The model escalation chain is: Nova Lite (128K) -> Nova Pro (300K) -> reject. Documents under 200 tokens skip LLM summarisation entirely and use the content as-is.

---

## Use Case 2: Browsing the Knowledge Wiki

**Scenario:** You want to explore what VCS knows about Amazon Bedrock.

### In the browser (Viking Explorer)

Navigate to the Wiki tab. The sidebar loads all wiki pages across four categories:

```
ENTITIES (142)
  Adoption
  Advanced Analytics
  Amazon Bedrock             <-- click this
  Amazon Bedrock Agents
  Amazon Bedrock Guardrails
  ...

CONCEPTS (81)
  Agentic Workflows
  AI Powered Infrastructure
  ...

CONTRADICTIONS (1)
  Builder Friendly Growth Stack

SYNTHESIS (0)
```

Clicking "Amazon Bedrock" loads the page detail panel on the right:

```
[entity]  3 sources  Compiled 2026-04-08T13:33:29.580Z

## Overview
Amazon Bedrock is a fully managed service that provides access to
foundation models from AI companies...

## Key Facts
- Bedrock supports models from Anthropic, Meta, Mistral...
  (Source: viking://resources/feed/aws-bedrock-guide.md)
- Pricing varies by model and token usage...
  (Source: viking://resources/feed/amazon-bedrock-pricing.md)

## Relationships
- [[Amazon Bedrock Agents]]      <-- clickable wikilink
- [[Amazon Bedrock Guardrails]]  <-- clickable wikilink
- [[Agentic Workflows]]          <-- clickable wikilink

## Human Notes
(none yet)

## Change Log
- 2026-04-08: Initial compilation from viking://resources/feed/...
- 2026-04-09: Merged from viking://resources/feed/amazon-bedrock-pricing.md
```

### How wikilinks work

The `[[Amazon Bedrock Agents]]` syntax in the stored markdown gets preprocessed before rendering:

1. `preprocessWikilinks` converts `[[Amazon Bedrock Agents]]` to `[Amazon Bedrock Agents](wikilink://Amazon%20Bedrock%20Agents)` with URL-encoded spaces
2. ReactMarkdown renders this as a link
3. The custom `<a>` component intercepts `wikilink://` URLs
4. `decodeURIComponent` recovers the page name
5. `normaliseName` strips hyphens and lowercases for fuzzy matching
6. The page name resolves to a URI via the `uriByName` lookup map
7. Clicking navigates within the wiki (no page reload)

If a wikilink references a page that doesn't exist, it renders as greyed-out text with a "Page not found" tooltip.

### How all pages load (pagination)

The wiki sidebar fetches pages using `api.lsAll()`, which follows the backend's `nextToken` pagination:

```
Request 1: GET /fs/ls?uri=viking://wiki/entities/
Response:  { items: [16 items], nextToken: "eyJsZX..." }

Request 2: GET /fs/ls?uri=viking://wiki/entities/&nextToken=eyJsZX...
Response:  { items: [16 items], nextToken: "eyJwYX..." }

...continues until no nextToken...

Request 9: GET /fs/ls?uri=viking://wiki/entities/&nextToken=eyJsZX...
Response:  { items: [14 items] }  // no nextToken = done

Total: 142 entities loaded across 9 API calls
```

A `MAX_PAGES = 50` guard prevents infinite loops from malformed responses.

---

## Use Case 3: Semantic Search from an AI Agent

**Scenario:** An AI agent asks VCS "How does DynamoDB single-table design work?"

### Via MCP

```json
{
  "tool": "find",
  "input": {
    "query": "How does DynamoDB single-table design work?",
    "max_results": 5,
    "min_score": 0.3
  }
}
```

### Via CLI

```bash
vcs find "How does DynamoDB single-table design work?" --max-results 5
```

### What happens

```
1. Generate query embedding
   "How does DynamoDB single-table design work?"
   -> Titan Embed V2 -> 1024-dim vector

2. Global ANN search (S3 Vectors, topK=10)
   Results:
     viking://resources/docs/dynamodb-design.md        dist=0.18
     viking://wiki/entities/dynamodb.md                dist=0.22
     viking://wiki/concepts/single-table-design.md     dist=0.25
     viking://resources/feed/aws-best-practices.md     dist=0.41
     viking://resources/                               dist=0.55
     ...

3. Score-blended drill-down
   viking://resources/ is a directory -> drill into children
     viking://resources/docs/dynamodb-patterns.md      dist=0.21
     viking://resources/docs/nosql-workbench.md        dist=0.38
   Blended score = 0.5 * similarity + 0.5 * parent_score

4. Convergence check
   Top-5 unchanged after 2 rounds -> converge

5. Return results (sorted by score)
   [
     { uri: "viking://resources/docs/dynamodb-design.md",
       score: 0.91,
       abstract: "Guide to DynamoDB single-table design..." },
     { uri: "viking://wiki/concepts/single-table-design.md",
       score: 0.87,
       abstract: "Single-table design consolidates..." },
     ...
   ]
   tokens_saved_estimate: 12,450
```

The `tokens_saved_estimate` shows how many tokens the agent saved by receiving L0 abstracts instead of full L2 content. The agent can then call `read` on specific URIs at L1 or L2 if it needs more detail.

---

## Use Case 4: Session-Aware Conversation Retrieval

**Scenario:** An AI agent is mid-conversation about AWS cost optimisation and the user asks "What about the Bedrock pricing we looked at earlier?"

### The session so far

```bash
# Agent created a session at the start
vcs session create
# -> session_id: abc-123

# Messages were recorded as the conversation progressed
vcs session message abc-123 user "Help me optimise our AWS bill"
vcs session message abc-123 assistant "I'll look at your cost drivers..."
vcs session message abc-123 user "Focus on Bedrock costs"
vcs session message abc-123 assistant "Looking at Bedrock pricing models..."

# URIs were recorded as the agent consulted documents
vcs session used abc-123 --uris viking://resources/feed/amazon-bedrock-pricing.md
```

### Now the user asks a follow-up

```bash
vcs search "What about the Bedrock pricing we looked at earlier?" \
  --session abc-123 --max-results 5
```

### What happens

```
1. Load session context
   +-- compression_summary: "Discussing AWS cost optimisation,
   |   focusing on Bedrock pricing models"
   +-- Last 5 messages loaded

2. Intent analysis (Nova Micro)
   Input: query + session context
   Output: {
     queries: [
       { query: "Amazon Bedrock pricing tiers and costs",
         context_type: "resource",
         intent: "retrieve specific pricing document",
         priority: 1 },
       { query: "Bedrock cost optimization preferences",
         context_type: "memory",
         intent: "check if user has cost preferences",
         priority: 3 }
     ]
   }

3. Route sub-queries (parallel)
   Resource query -> S3 Vectors drill-down
     -> Finds: amazon-bedrock-pricing.md (high score because
        it was already used in this session)
   Memory query -> AgentCore RetrieveMemoryRecords
     -> Finds: user preference "prefer reserved capacity
        for predictable workloads"

4. Merge and group results
   {
     resources: [
       { uri: "viking://resources/feed/amazon-bedrock-pricing.md",
         score: 0.94, abstract: "..." }
     ],
     memories: [
       { uri: "viking://user/memories/preferences/...",
         score: 0.72, abstract: "Prefer reserved capacity..." }
     ],
     skills: [],
     query_plan: [sub-queries above],
     tokens_saved: 8,200
   }
```

The session context enables the search to understand that "the Bedrock pricing we looked at earlier" refers to the specific document consulted in this session, not just any Bedrock pricing content.

---

## Use Case 5: Memory Extraction from Conversations

**Scenario:** After a productive conversation about infrastructure preferences, the session is committed and memories are extracted.

### Commit the session

```bash
vcs session commit abc-123
```

### What happens

```
Phase 1: Archive
  +-- Read all 12 messages from DynamoDB
  +-- Format for LLM: "user: ...\nassistant: ...\n"
  +-- Summarise via Nova Lite:
  |   {
  |     one_line: "AWS cost optimisation session focused on
  |                Bedrock pricing and reserved capacity",
  |     analysis: "User is evaluating Bedrock costs for
  |                production workloads...",
  |     key_concepts: ["Bedrock pricing", "reserved capacity",
  |                    "cost per token"],
  |     pending_tasks: ["Compare on-demand vs provisioned throughput"]
  |   }
  +-- Archive to S3:
      s3://content-bucket/archives/abc-123/messages.json
      s3://content-bucket/archives/abc-123/summary.json

Phase 2: Persist session node
  +-- Write L0/L1 to viking://session/abc-123/
  +-- Generate embedding, store vector
  +-- Session is now searchable

Phase 3: Finalize
  +-- Status -> 'committed'
  +-- Set 30-day TTL on all session items
  +-- Enqueue rollup for viking://session/

Phase 4: Memory extraction (async, via AgentCore)
  +-- AgentCore detects 12 messages > threshold (6)
  +-- Triggers extraction job
  +-- SNS notification -> Memory Bridge Lambda
```

### Memory Bridge processes the extraction

```
For each extracted context entry:

Entry: "User prefers reserved capacity for predictable workloads"
  |
  v
1. Classify (Nova Micro)
   -> category: "preferences", confidence: 0.89
  |
  v
2. Generate embedding (Titan V2)
  |
  v
3. Dedup check
   -> Search existing preferences memories
   -> No similar memory found (cosine distance > 0.2)
  |
  v
4. Write memory
   -> viking://user/memories/preferences/20260409-abc123.md
   -> L0: "User prefers reserved capacity for predictable workloads"
   -> Vector stored in S3 Vectors
  |
  v
5. Enqueue for compilation
   -> Compiler may extract "Reserved Capacity" as a concept

Entry: "User works with Bedrock in ap-southeast-2"
  |
  v
1. Classify -> category: "profile", confidence: 0.82
  |
  v
2-3. Embedding + dedup check
   -> Found existing memory: "User is based in Sydney, ap-southeast-2"
   -> cosine similarity: 0.85 > threshold (0.8)
   -> LLM dedup decision: "merge"
   -> Merged: "User is based in Sydney (ap-southeast-2),
               works with Bedrock in this region"
  |
  v
4. Delete old memory, write merged version
```

The next time an agent searches for user preferences, both the original and the merged memory will surface through AgentCore's semantic search.

---

## Use Case 6: Knowledge Compilation - From Document to Wiki

**Scenario:** A blog post about AI coding agents is ingested. The compiler automatically builds wiki pages.

### The trigger

When `vcs feed https://example.com/ai-coding-agents-article` completes ingestion, the write pipeline enqueues a compilation job:

```
SQS FIFO: compile queue
Message: { sourceUri: "viking://resources/feed/ai-coding-agents.md" }
```

### Compiler flow

```
1. Read source L1 (summarised sections)
   "AI coding agents can rapidly ship features but struggle
    with measuring impact. The adoption gap requires systematic
    approaches including growth engineering loops..."

2. Extract entities & concepts (Nova Lite, tool-use)
   {
     entities: [
       { name: "AI Coding Agents", type: "tool",
         description: "Autonomous coding tools that..." },
       { name: "Growth Engineering Loop", type: "tool",
         description: "Weekly cycle of instrumenting..." }
     ],
     concepts: [
       { name: "Adoption Gap", description: "The disconnect
         between shipping features and user adoption..." },
       { name: "Builder-Friendly Growth Stack",
         description: "Four-system approach: message, friction,
         measurement, distribution..." }
     ]
   }

3. Process each entity/concept:

   "AI Coding Agents" entity:
     +-- Search existing wiki pages (vector similarity)
     +-- No match found (distance > 0.3)
     +-- CREATE new page via Nova Pro:
         viking://wiki/entities/ai-coding-agents.md
         +-- Frontmatter (built in code, not LLM):
         |   type: entity
         |   name: "AI Coding Agents"
         |   entity_type: "tool"
         |   source_count: 1
         |   sources: [viking://resources/feed/ai-coding-agents.md]
         +-- Body (generated by Nova Pro):
             ## Overview
             AI coding agents are autonomous tools that...

             ## Key Facts
             - Can rapidly ship features but struggle with
               measuring impact (Source: viking://resources/...)

             ## Relationships
             - [[Adoption Gap]]
             - [[Growth Engineering Loop]]

             ## Human Notes
             (none yet)

             ## Change Log
             - 2026-04-09: Initial compilation

   "Adoption Gap" concept:
     +-- Search existing wiki pages
     +-- MATCH found: viking://wiki/concepts/adoption-gap.md
         (distance: 0.12 < threshold 0.3)
     +-- MERGE into existing page via Nova Pro:
         +-- Read existing L2 content
         +-- buildMergePrompt(template, existingBody, newL1, sourceUri)
         +-- Nova Pro merges: preserves existing facts,
             adds new facts with source attribution
         +-- Check for contradictions in merged content
         +-- Update frontmatter: source_count++, add new source
         +-- Preserve Human Notes (never sent to LLM)

4. Budget tracking
   Each Nova Pro call increments daily counter
   Cap: 500 calls/day (configurable via env var)
   If exceeded: job status -> 'budget_exceeded'
```

### The result

After compilation, the wiki has:
- 2 new entity pages created
- 1 existing concept page updated with merged content
- 1 existing concept page updated
- 0 contradictions detected (in this case)
- Wiki index and compilation log updated

---

## Use Case 7: Contradiction Detection

**Scenario:** Two ingested documents make conflicting claims about the same entity.

### The setup

Document A (ingested last week):
> "Amazon Bedrock supports up to 5 concurrent model invocations per account."

Document B (ingested today):
> "Amazon Bedrock allows 15 concurrent invocations with provisioned throughput."

### What happens during compilation merge

```
1. Compiler merges Document B into the existing Bedrock entity page

2. Nova Pro's merge response includes a contradiction block:
   CONTRADICTIONS_DETECTED:
   [{
     "claim_a": "Supports up to 5 concurrent invocations per account",
     "source_a": "viking://resources/feed/bedrock-limits-2024.md",
     "claim_b": "Allows 15 concurrent invocations with provisioned throughput",
     "source_b": "viking://resources/feed/bedrock-updates-2026.md",
     "analysis": "These claims conflict on concurrency limits.
                  Claim B may reflect updated limits or different
                  configuration (provisioned vs on-demand)."
   }]

3. Three-gate validation:

   Gate 1: LLM extraction (already done above)

   Gate 2: Semantic similarity check
     +-- Embed claim A -> vector
     +-- Embed claim B -> vector
     +-- Cosine similarity: 0.62
     +-- 0.62 < 0.75 threshold -> NOT a restatement
     +-- PASS (genuine conflict)

   Gate 3: Subset/elaboration check
     +-- Extract key terms (filter stopwords):
         A: {bedrock, supports, 5, concurrent, invocations, account}
         B: {bedrock, allows, 15, concurrent, invocations, provisioned, throughput}
     +-- Overlap: 3/6 = 50%
     +-- 50% < 70% threshold -> NOT an elaboration
     +-- PASS (genuine conflict)

4. Create contradiction page:
   viking://wiki/contradictions/amazon-bedrock-mnq3bm5s.md

   ---
   type: contradiction
   entities: ["Amazon Bedrock"]
   sources:
     - viking://resources/feed/bedrock-limits-2024.md
     - viking://resources/feed/bedrock-updates-2026.md
   flagged: 2026-04-09T14:22:10.000Z
   resolved: false
   ---

   # Contradiction: Amazon Bedrock

   ## Claim A (bedrock-limits-2024.md)
   Supports up to 5 concurrent invocations per account

   ## Claim B (bedrock-updates-2026.md)
   Allows 15 concurrent invocations with provisioned throughput

   ## Analysis
   These claims conflict on concurrency limits...

   ## Resolution
   Status: unresolved
   Decision: (pending review)
```

### What gets filtered out

The three-gate system prevents false contradictions:

- **Gate 2 catches restatements:** "Bedrock is a managed AI service" vs "Bedrock provides managed access to AI models" (cosine similarity > 0.75 = same claim, different words)
- **Gate 3 catches elaborations:** "Bedrock supports Claude" vs "Bedrock supports Claude, Llama, and Mistral models" (70%+ word overlap = one claim extends the other)

---

## Use Case 8: Navigating the Namespace

**Scenario:** You want to understand the structure and contents of your knowledge base.

### CLI exploration

```bash
# See the top-level namespace
$ vcs tree viking:// --depth 2

viking://
  resources/         87 items, "Technical documentation and guides..."
    feed/            42 items
    docs/            45 items
  user/              23 items, "User profile, preferences, and memories"
    memories/        23 items
  agent/             5 items, "Agent skills and procedures"
  session/           34 items, "Archived conversation sessions"
  wiki/              224 items, "Compiled knowledge pages"
    entities/        142 items
    concepts/        81 items
    contradictions/  1 item
    synthesis/       0 items
  schema/            3 items
  log/               12 items

# Read a specific document at different detail levels
$ vcs read viking://resources/feed/aws-bedrock-guide.md --level 0
"Guide to Amazon Bedrock covering model selection, pricing tiers,
 and integration patterns. Recommends Nova models for cost-sensitive
 workloads and Claude for complex reasoning tasks."

$ vcs read viking://resources/feed/aws-bedrock-guide.md --level 1
[
  { "title": "Model Selection", "summary": "Compare models by..." },
  { "title": "Pricing", "summary": "Three pricing tiers..." },
  { "title": "Integration", "summary": "SDK setup and..." }
]

$ vcs read viking://resources/feed/aws-bedrock-guide.md --level 2
# Full markdown content (may be thousands of tokens)
```

### Browser exploration (Navigator view)

The Navigator provides a three-pane interface:

```
+---Tree View---+----Entry List--------+----Entry Detail-----------+
| viking://     | resources/feed/      |                           |
|  resources/   |  aws-bedrock.md      | aws-wellarchitected.md    |
|    feed/  <-- |  aws-waf.md          | entity | 3 sources        |
|    docs/      |  aws-wellarch... <-- |                           |
|  user/        |  dynamodb-guide.md   | ## Overview               |
|  wiki/        |  ...                 | The AWS Well-Architected  |
|  session/     |                      | Framework defines...      |
|               |                      |                           |
|               |                      | [L0] [L1] [L2]           |
+---------------+----------------------+---------------------------+
```

Click any entry to see its content. Toggle between L0 (abstract), L1 (outline), and L2 (full text) using the level tabs.

---

## Use Case 9: Embedding Map Exploration

**Scenario:** You want to visualise how your knowledge base is organised semantically.

### Browser Map view

The Map tab fetches all vector embeddings from the `/vectors` endpoint, projects them from 1024 dimensions to 2D using UMAP, and renders them on a zoomable canvas:

```
  +---------------------------------------------------------------+
  |                         Map View                               |
  |  [scope: all v]                                                |
  |                                                                |
  |        o  o                    o = resource                    |
  |       o oo o                  * = memory                      |
  |        ooo      ** *          + = wiki entity                 |
  |       o  o       ***          x = wiki concept                |
  |                   *                                            |
  |    +++++                                                       |
  |   ++ ++++     xxx                                              |
  |    +++ +       xxxx                                            |
  |     ++          xx                                             |
  |                                                                |
  |              (hover for URI and abstract)                      |
  +---------------------------------------------------------------+
```

Documents about similar topics cluster together. Wiki entities and concepts form their own clusters that often sit near the resource documents they were compiled from. Memories cluster by category.

The scope filter lets you isolate specific content types to see their internal organisation.

---

## Use Case 10: Wiki Graph Relationships

**Scenario:** You want to see how wiki pages connect to each other.

### Switching to graph view

In the Wiki tab, click the graph icon to switch from list mode to graph mode:

```
  +---Graph View------------------------------------------------+
  |                                                              |
  |        [Adoption]---[Adoption Gap]                           |
  |            |              |                                  |
  |            |       [Growth Engineering Loop]                 |
  |            |              |                                  |
  |    [AI Coding Agents]-----+                                  |
  |            |                                                 |
  |    [Skills]----[Builder-Friendly Growth Stack]               |
  |                       |                                      |
  |               [Guardrails]                                   |
  |                                                              |
  |   Blue = entity                                              |
  |   Green = concept                                            |
  |   Purple = synthesis                                         |
  |   Red = contradiction                                        |
  +--------------------------------------------------------------+
```

### How edges are derived

Edges in the graph aren't stored explicitly. They're computed client-side from `[[wikilinks]]` in page content:

```
1. Fetch L2 content for all wiki pages (paginated via lsAll)

2. For each page, extract [[wikilinks]] using regex:
   /\[\[([^\]]+)\]\]/g

3. For each wikilink target name:
   a. Normalise: lowercase, strip hyphens, collapse spaces
      "Builder-friendly growth stack" -> "builder friendly growth stack"
   b. Look up in uriByName map (stores formatted names + slugs + normalised forms)
   c. If found: create edge from source page to target page
   d. If not found: no edge (target might not exist as a page)

4. Deduplicate edges (Set of "source->target" keys)

5. Render with react-force-graph-2d (force-directed layout)
```

Clicking a node in the graph selects it and shows its full content in the right panel, just like clicking in list mode.

---

## How These Use Cases Connect

These aren't isolated features. They form a continuous knowledge lifecycle:

```
  INGEST                    COMPILE                   RETRIEVE
  +----------+             +------------+             +----------+
  | vcs feed |             | Extraction |             | vcs find |
  | vcs ingest|---write--->| Wiki pages |---search--->| vcs search|
  | vcs remember|  pipeline | Merge      |             | MCP tools|
  +----------+             | Contradict |             +----------+
       |                    +------------+                  |
       |                         |                          |
       v                         v                          v
  +-----------+            +----------+              +-----------+
  | Session   |            | Wiki     |              | AI Agent  |
  | Messages  |---commit-->| Browse   |<--explore----| Response  |
  | Usage     |            | Graph    |              | with      |
  +-----------+            +----------+              | context   |
       |                                              +-----------+
       v
  +-----------+
  | Memory    |
  | Extract   |---classify + dedup--->  viking://user/memories/
  | Bridge    |
  +-----------+
```

1. **Documents are ingested** via CLI or API (Use Cases 1, 8)
2. **The compiler extracts knowledge** into wiki pages automatically (Use Case 6)
3. **Contradictions are flagged** when sources disagree (Use Case 7)
4. **Users browse the wiki** and graph to understand their knowledge (Use Cases 2, 10)
5. **AI agents search** for relevant context during conversations (Use Cases 3, 4)
6. **Sessions capture** what was discussed and which documents were used (Use Case 4)
7. **Memories are extracted** from sessions and fed back into the knowledge base (Use Case 5)
8. **The cycle repeats** as memories trigger new compilation, enriching the wiki further
