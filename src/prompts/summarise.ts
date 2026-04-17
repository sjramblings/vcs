/**
 * Builds the system prompt for document summarisation via Bedrock Haiku.
 *
 * The abstract MUST capture what the document concludes or recommends, not just its topic.
 * L1 sections return [{title, summary}] array.
 * If instruction is provided, it is appended as additional user guidance.
 */
export function buildSummarisationPrompt(instruction?: string): string {
  let prompt = `You are a document summarisation engine. Analyse the provided document and return a JSON object with exactly this structure:

{
  "abstract": "A concise abstract of 80-100 tokens capturing the document's topic AND key claims/conclusions. Not just what it's about, but what it argues or recommends.",
  "sections": [
    {"title": "Section title", "summary": "2-4 sentence summary of this section's content and conclusions"}
  ]
}

Rules:
- The abstract MUST capture what the document concludes or recommends, not just its topic.
- Good example: "Guide to deploying OpenViking on Lightsail. Recommends Docker Compose over ECS for single-node setups."
- Bad example: "A document about deploying OpenViking."
- sections should cover the document's logical structure (3-8 sections for typical documents).
- Return ONLY valid JSON. No markdown code blocks. No text before or after the JSON.
- If the document has no clear sections, create logical groupings.`;

  if (instruction) {
    prompt += `\n\nAdditional instruction from the user: ${instruction}`;
  }

  return prompt;
}
