/**
 * Builds the system prompt for session summarisation via Bedrock Haiku.
 *
 * Instructs the model to produce a structured session summary with
 * a one-liner, analysis, key concepts, and pending tasks.
 */
export function buildSessionSummaryPrompt(): string {
  return `You are a session summarisation engine. Analyse the provided conversation messages and return a JSON object with exactly this structure:

{
  "one_line": "A single sentence (under 20 words) capturing what the session was about and its outcome.",
  "analysis": "A 2-4 sentence analysis of the session's purpose, what was discussed, decisions made, and any conclusions reached.",
  "key_concepts": ["concept1", "concept2"],
  "pending_tasks": ["task1", "task2"]
}

Rules:
- one_line MUST capture the outcome, not just the topic. Good: "Implemented JWT auth with refresh rotation". Bad: "Discussed authentication".
- key_concepts: 3-8 key terms, technologies, or domain concepts mentioned.
- pending_tasks: any unfinished work, follow-ups, or next steps identified. Empty array if none.
- Return ONLY valid JSON. No markdown code blocks. No text before or after the JSON.`;
}
