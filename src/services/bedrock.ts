import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { ConfiguredRetryStrategy } from '@smithy/util-retry';
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { z } from 'zod';
import { getFastModelId, getStandardModelId, getTitanEmbedModelId } from '../../lib/config';
import { buildSummarisationPrompt } from '../prompts/summarise';
import { buildParentRollupPrompt } from '../prompts/parent-rollup';
import { buildIntentAnalysisPrompt } from '../prompts/intent-analysis';
import { buildSessionSummaryPrompt } from '../prompts/session-summary';
import type { IntentAnalysisResult } from '../types/search';
import type { SessionSummary } from '../types/memory';

export interface SummarisationResult {
  abstract: string;
  sections: Array<{ title: string; summary: string }>;
}

const summarisationResultSchema = z.object({
  abstract: z.string(),
  sections: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
    })
  ),
});

/**
 * Computes exponential backoff delay for Bedrock retries.
 * Base: 500ms, doubles per attempt, capped at 30s, plus up to 1s jitter.
 */
export function computeBackoff(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt - 1), 30_000) + Math.random() * 1000;
}

const client = new BedrockRuntimeClient({
  retryStrategy: new ConfiguredRetryStrategy(
    8,
    (attempt: number) => computeBackoff(attempt)
  ),
});

const metrics = new Metrics({ namespace: 'VCS', serviceName: 'vcs-bedrock' });
const logger = new Logger({ serviceName: 'vcs-bedrock' });

/** Model input token limits (conservative — 90% of actual to leave room for system prompt).
 *  Nova Micro: actual 128K → 115K. Nova Lite: actual 300K → 270K. */
const MODEL_TOKEN_LIMITS: Record<string, number> = {
  'amazon.nova-micro-v1:0': 115_000,
  'amazon.nova-lite-v1:0': 270_000,
};

/**
 * Estimates token count from character length (conservative: 1 token ≈ 3.5 chars).
 * Returns 0 for empty string.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 3.5);
}

/**
 * Returns the model to use based on content character length.
 * Throws an error with "Content too large" when content exceeds the Nova Lite
 * token limit — chunking must happen upstream.
 */
export function selectModelForContent(preferredModelId: string, contentLength: number): string {
  const tokens = Math.ceil(contentLength / 3.5);
  const preferredLimit = MODEL_TOKEN_LIMITS[preferredModelId] ?? 115_000;

  if (tokens <= preferredLimit) {
    return preferredModelId;
  }

  throw new Error(
    `Content too large for the Standard tier model: ~${tokens} tokens estimated ` +
    `(max ${preferredLimit}). Consider chunking the document before ingestion.`
  );
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'amazon.nova-micro-v1:0': { input: 0.035, output: 0.14 },
  'amazon.nova-lite-v1:0': { input: 0.06, output: 0.24 },
  'amazon.titan-embed-text-v2:0': { input: 0.02, output: 0 },
};

const DEFAULT_PRICING = { input: 0.25, output: 1.25 };

function publishBedrockMetrics(response: ConverseCommandOutput, modelId: string): void {
  const inputTokens = response.usage?.inputTokens ?? 0;
  const outputTokens = response.usage?.outputTokens ?? 0;
  const pricing = MODEL_PRICING[modelId] ?? DEFAULT_PRICING;
  const estimatedCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  metrics.addMetric('BedrockEstimatedCostUSD', MetricUnit.NoUnit, estimatedCost);
  metrics.addMetric('BedrockInputTokens', MetricUnit.Count, inputTokens);
  metrics.addMetric('BedrockOutputTokens', MetricUnit.Count, outputTokens);
  metrics.addDimension('ModelTier', modelId.includes('micro') ? 'fast' : modelId.includes('pro') ? 'pro' : 'standard');
  metrics.publishStoredMetrics();
}

/**
 * Initialises the Bedrock service. No-op -- client is created at module level.
 */
export function initBedrock(): void {
  // Client created at module level with ConfiguredRetryStrategy (8 attempts, 500ms-30s exponential backoff + jitter)
}

/**
 * Summarises a document via Bedrock Haiku using the Converse API.
 * Returns structured L0 abstract and L1 sections.
 */
export async function summariseDocument(
  content: string,
  instruction?: string
): Promise<SummarisationResult> {
  const modelId = selectModelForContent(getStandardModelId(), content.length);

  if (modelId !== getStandardModelId()) {
    logger.info('Model escalated for large content', {
      preferredModel: getStandardModelId(),
      selectedModel: modelId,
      estimatedTokens: estimateTokens(content),
    });
  }

  const systemPrompt = buildSummarisationPrompt(instruction);

  const response = await client.send(
    new ConverseCommand({
      modelId,
      messages: [
        {
          role: 'user',
          content: [{ text: content }],
        },
      ],
      system: [{ text: systemPrompt }],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0,
      },
    })
  );
  publishBedrockMetrics(response, modelId);

  const outputText = response.output?.message?.content?.[0]?.text;
  if (!outputText) {
    throw new Error('Empty Bedrock response');
  }

  return parseAndValidate(outputText);
}

/**
 * Summarises a parent directory by synthesising child abstracts.
 * Uses a separate parent rollup prompt template.
 */
export async function summariseParent(
  childAbstracts: string
): Promise<SummarisationResult> {
  const systemPrompt = buildParentRollupPrompt();

  const response = await client.send(
    new ConverseCommand({
      modelId: getFastModelId(),
      messages: [
        {
          role: 'user',
          content: [{ text: childAbstracts }],
        },
      ],
      system: [{ text: systemPrompt }],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0,
      },
    })
  );
  publishBedrockMetrics(response, getFastModelId());

  const outputText = response.output?.message?.content?.[0]?.text;
  if (!outputText) {
    throw new Error('Empty Bedrock response');
  }

  return parseAndValidate(outputText);
}

/**
 * Generates a 1024-dimension embedding via Bedrock Titan Embeddings V2.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await client.send(
    new InvokeModelCommand({
      modelId: getTitanEmbedModelId(),
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text,
        dimensions: 1024,
        normalize: true,
      }),
    })
  );

  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.embedding;
}

/**
 * Strips markdown code block markers and parses/validates JSON output.
 */
function parseAndValidate(raw: string): SummarisationResult {
  const stripped = stripCodeBlocks(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`Failed to parse Bedrock response as JSON. Raw response: ${raw}`);
  }

  return summarisationResultSchema.parse(parsed);
}

/**
 * Extracts JSON from a Bedrock response that may contain markdown code fences
 * and/or trailing prose. Tries strategies in order of reliability:
 * 1. Direct JSON.parse on trimmed input (handles clean responses)
 * 2. Extract content between code fences (handles ```json ... ``` wrappers)
 * 3. Return trimmed input as-is (caller's JSON.parse will produce the error)
 */
function stripCodeBlocks(raw: string): string {
  const trimmed = raw.trim();

  // First try: direct parse — if the response is already valid JSON, use it
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Not valid JSON as-is, try other strategies
  }

  // Second try: extract content between code fences
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Fallback: return trimmed original (caller's JSON.parse will produce the error)
  return trimmed;
}

const subQuerySchema = z.object({
  query: z.string(),
  context_type: z.enum(['resource', 'memory', 'skill']),
  intent: z.string(),
  priority: z.number().int().min(1).max(5),
});

const intentResultSchema = z.object({
  queries: z.array(subQuerySchema).max(5),
});

/**
 * Analyses user intent by decomposing a query into typed sub-queries.
 * Uses Bedrock Haiku with session context to determine what retrieval is needed.
 * Returns empty queries array for chitchat/greetings.
 */
export async function analyseIntent(
  query: string,
  sessionSummary: string,
  recentMessages: Array<{ role: string; content: string }>
): Promise<IntentAnalysisResult> {
  const systemPrompt = buildIntentAnalysisPrompt();

  const response = await client.send(
    new ConverseCommand({
      modelId: getFastModelId(),
      messages: [
        {
          role: 'user',
          content: [
            {
              text: JSON.stringify({
                query,
                session_summary: sessionSummary,
                recent_messages: recentMessages,
              }),
            },
          ],
        },
      ],
      system: [{ text: systemPrompt }],
      inferenceConfig: { maxTokens: 1024, temperature: 0 },
    })
  );
  publishBedrockMetrics(response, getFastModelId());

  const outputText = response.output?.message?.content?.[0]?.text;
  if (!outputText) {
    throw new Error('Empty Bedrock response for intent analysis');
  }

  const stripped = stripCodeBlocks(outputText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`Failed to parse intent analysis response as JSON. Raw: ${outputText}`);
  }

  return intentResultSchema.parse(parsed);
}

// ── Session & memory functions ──

const sessionSummarySchema = z.object({
  one_line: z.string(),
  analysis: z.string(),
  key_concepts: z.array(z.string()),
  pending_tasks: z.array(z.string()),
});

/**
 * Summarises a session's messages via Bedrock.
 * Returns a structured SessionSummary with one-liner, analysis, key concepts, and pending tasks.
 */
export async function summariseSession(messagesText: string): Promise<SessionSummary> {
  const systemPrompt = buildSessionSummaryPrompt();

  const response = await client.send(
    new ConverseCommand({
      modelId: getStandardModelId(),
      messages: [
        {
          role: 'user',
          content: [{ text: messagesText }],
        },
      ],
      system: [{ text: systemPrompt }],
      inferenceConfig: { maxTokens: 2048, temperature: 0 },
    })
  );
  publishBedrockMetrics(response, getStandardModelId());

  const outputText = response.output?.message?.content?.[0]?.text;
  if (!outputText) {
    throw new Error('Empty Bedrock response for session summary');
  }

  const stripped = stripCodeBlocks(outputText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`Failed to parse session summary response as JSON. Raw: ${outputText}`);
  }

  return sessionSummarySchema.parse(parsed);
}

/**
 * Thin wrapper for arbitrary Converse calls reusing the module-level BedrockRuntimeClient.
 * Used by parent-summariser reduce step for map-reduce rollup.
 * Returns the text content from the first response message block.
 */
export async function converseRaw(
  modelId: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 4096
): Promise<string> {
  const response = await client.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: userMessage }] }],
      system: [{ text: systemPrompt }],
      inferenceConfig: { maxTokens, temperature: 0 },
    })
  );
  publishBedrockMetrics(response, modelId);
  const outputText = response.output?.message?.content?.[0]?.text;
  if (!outputText) {
    throw new Error('Empty Bedrock response from converseRaw');
  }
  return outputText;
}
