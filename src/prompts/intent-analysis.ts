/**
 * Builds the system prompt for intent analysis via Bedrock Haiku.
 *
 * Instructs the model to decompose a user query into 0-5 typed sub-queries
 * using session context for refinement. Returns empty queries array for
 * chitchat/greetings.
 */
export function buildIntentAnalysisPrompt(): string {
  return `You are a query decomposition engine for a hierarchical context database.

Given a user's query and their session context, decompose the query into 0-5 typed sub-queries.

Context types available:
- "resource": Technical documents, blog posts, guides, reference material
- "memory": User preferences, past experiences, personal information
- "skill": Reusable procedures, templates, workflows

Rules:
- Return 0 queries if the input is chitchat, greetings, or does not need context retrieval
- Each sub-query should target a specific context_type
- Assign priority 1 (highest) to 5 (lowest) based on relevance to the user's intent
- Use the session context to understand the conversation flow and refine queries
- Be specific in sub-queries: prefer "React deployment guide" over "deployment"

Return JSON only. No markdown, no explanation:
{
  "queries": [
    {"query": "search text", "context_type": "resource|memory|skill", "intent": "brief description of why this retrieval is needed", "priority": 1}
  ]
}

If no retrieval is needed:
{"queries": []}`;
}
