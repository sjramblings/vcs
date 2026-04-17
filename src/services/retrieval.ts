import { generateEmbedding } from './bedrock';
import { queryVectors } from './s3-vectors';
import { getItem } from './dynamodb';
import type {
  FindRequest,
  FindResponse,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SubQuery,
  TrajectoryStep,
} from '../types/search';

// --- Constants ---

const GLOBAL_SEARCH_TOP_K = 10;
const MAX_DEPTH = 5;
const CONVERGENCE_ROUNDS = 3;
const SCORE_ALPHA = 0.5; // embedding weight in score propagation
const DEFAULT_DRILL_TOP_K = 10;
const SCOPE_SEARCH_TOP_K = 20; // request more candidates when scope filtering

// --- Helpers ---

/**
 * Converts S3 Vectors cosine distance [0, 2] to similarity score [0, 1].
 */
function cosineDistanceToScore(distance: number): number {
  return 1 - distance / 2;
}

/**
 * Approximate token count from text length (~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- Internal types ---

interface Candidate {
  uri: string;
  score: number;
  metadata: Record<string, unknown>;
}

interface DrillDownResult {
  candidates: Map<string, Candidate>;
  trajectory: TrajectoryStep[];
}

// --- Core drill-down algorithm ---

/**
 * Recursive drill-down retrieval algorithm.
 *
 * 1. Embed query via Titan V2
 * 2. Global search with topK=3 (or more with scope)
 * 3. Score propagation: blended = 0.5 * embedding + 0.5 * parent
 * 4. Drill into directories, converge when top-5 stable for 3 rounds
 * 5. Max depth 5 hard limit
 */
async function drillDown(
  query: string,
  scope: string | undefined,
  maxResults: number,
  minScore: number
): Promise<DrillDownResult> {
  const trajectory: TrajectoryStep[] = [];
  const candidateMap = new Map<string, Candidate>();
  let stepCounter = 0;

  // 1. Generate embedding
  const embedding = await generateEmbedding(query);

  // 2. Global search
  const globalTopK = scope ? SCOPE_SEARCH_TOP_K : GLOBAL_SEARCH_TOP_K;
  let globalResults = await queryVectors(embedding, globalTopK);

  // Apply scope post-filter if provided
  if (scope) {
    globalResults = globalResults.filter((v) =>
      (v.metadata.uri as string).startsWith(scope)
    );
  }

  // 3. Process global results
  stepCounter++;
  trajectory.push({
    step: stepCounter,
    action: 'global_search',
    candidates: globalResults.length,
  });

  const directoriesToDrill: string[] = [];

  for (const result of globalResults) {
    const similarity = cosineDistanceToScore(result.distance);
    const blendedScore = SCORE_ALPHA * similarity + (1 - SCORE_ALPHA) * 0;
    const uri = result.key;

    candidateMap.set(uri, {
      uri,
      score: blendedScore,
      metadata: result.metadata,
    });

    // Track directories for drill-down
    if (result.metadata.is_directory) {
      directoriesToDrill.push(uri);
    }
  }

  // 4. Drill-down loop
  const topKHistory: string[][] = [];
  let currentDrillTargets = directoriesToDrill;

  for (let round = 0; round < MAX_DEPTH; round++) {
    if (currentDrillTargets.length === 0) break;

    const nextDrillTargets: string[] = [];

    for (const dirUri of currentDrillTargets) {
      const parentScore = candidateMap.get(dirUri)?.score ?? 0;

      let drillResults = await queryVectors(embedding, DEFAULT_DRILL_TOP_K, {
        parent_uri: { $eq: dirUri },
      });

      // Apply scope filter on drill results too
      if (scope) {
        drillResults = drillResults.filter((v) =>
          (v.metadata.uri as string).startsWith(scope)
        );
      }

      for (const result of drillResults) {
        const similarity = cosineDistanceToScore(result.distance);
        const blendedScore =
          SCORE_ALPHA * similarity + (1 - SCORE_ALPHA) * parentScore;
        const uri = result.key;

        const existing = candidateMap.get(uri);
        if (!existing || blendedScore > existing.score) {
          candidateMap.set(uri, {
            uri,
            score: blendedScore,
            metadata: result.metadata,
          });
        }

        if (result.metadata.is_directory) {
          nextDrillTargets.push(uri);
        }
      }

      stepCounter++;
      trajectory.push({
        step: stepCounter,
        action: 'drill',
        uri: dirUri,
        candidates: drillResults.length,
      });
    }

    // Extract current top-5 URIs by score
    const sortedCandidates = [...candidateMap.values()].sort(
      (a, b) => b.score - a.score
    );
    const currentTop5 = sortedCandidates.slice(0, 5).map((c) => c.uri);
    topKHistory.push(currentTop5);

    // Check convergence: top-5 unchanged for CONVERGENCE_ROUNDS
    if (topKHistory.length >= CONVERGENCE_ROUNDS) {
      const recent = topKHistory.slice(-CONVERGENCE_ROUNDS);
      const allSame = recent.every(
        (uris) =>
          uris.length === recent[0].length &&
          uris.every((u, i) => u === recent[0][i])
      );

      if (allSame) {
        stepCounter++;
        trajectory.push({
          step: stepCounter,
          action: 'converged',
          rounds: CONVERGENCE_ROUNDS,
        });
        break;
      }
    }

    currentDrillTargets = nextDrillTargets;
  }

  return { candidates: candidateMap, trajectory };
}

// --- Token savings calculation ---

/**
 * Calculates tokens saved by using L0 abstracts instead of full L2 content.
 * For each result URI: L2 tokens (from content or estimate) minus L0 tokens.
 */
async function calculateTokensSaved(
  candidates: Map<string, Candidate>
): Promise<number> {
  let totalL2Tokens = 0;
  let totalL0Tokens = 0;

  const entries = [...candidates.values()];

  for (const candidate of entries) {
    try {
      // Get L0 item for abstract token count
      const l0Item = await getItem(candidate.uri, 0);
      if (l0Item?.content) {
        totalL0Tokens += estimateTokens(l0Item.content);
      }

      // Get L2 item for full content token estimate
      const l2Item = await getItem(candidate.uri, 2);
      if (l2Item?.content) {
        totalL2Tokens += estimateTokens(l2Item.content);
      } else if (l2Item?.s3_key) {
        // Reasonable default for stored L2 content
        totalL2Tokens += 2000;
      }
    } catch {
      // Skip items that can't be read
    }
  }

  return Math.max(0, totalL2Tokens - totalL0Tokens);
}

// --- Result grouping ---

/** Internal result type that carries context_type for grouping. */
interface TaggedResult extends SearchResult {
  context_type: string;
}

/**
 * Groups tagged results by context_type into memories, resources, skills.
 * Each group sorted by score descending.
 * Strips the context_type field from the final output.
 */
function groupByContextType(results: TaggedResult[]): {
  memories: SearchResult[];
  resources: SearchResult[];
  skills: SearchResult[];
} {
  const memories: TaggedResult[] = [];
  const resources: TaggedResult[] = [];
  const skills: TaggedResult[] = [];

  for (const result of results) {
    switch (result.context_type) {
      case 'memory':
        memories.push(result);
        break;
      case 'skill':
        skills.push(result);
        break;
      case 'resource':
      default:
        resources.push(result);
        break;
    }
  }

  const strip = (items: TaggedResult[]): SearchResult[] => {
    items.sort((a, b) => b.score - a.score);
    return items.map(({ context_type: _, ...rest }) => rest);
  };

  return { memories: strip(memories), resources: strip(resources), skills: strip(skills) };
}

// --- Candidate to SearchResult conversion ---

function candidatesToResults(
  candidates: Map<string, Candidate>,
  maxResults: number,
  minScore: number,
  scope?: string
): TaggedResult[] {
  let entries = [...candidates.values()];

  // Post-filter by scope
  if (scope) {
    entries = entries.filter((c) => c.uri.startsWith(scope));
  }

  // Filter by min_score
  entries = entries.filter((c) => c.score >= minScore);

  // Sort by score descending
  entries.sort((a, b) => b.score - a.score);

  // Limit to max_results
  entries = entries.slice(0, maxResults);

  return entries.map((c): TaggedResult => ({
    uri: c.uri,
    level: (c.metadata.level as number) ?? 0,
    score: c.score,
    abstract: (c.metadata.abstract as string) ?? '',
    context_type: (c.metadata.context_type as string) ?? 'resource',
  }));
}

// --- Exported functions ---

/**
 * Stateless single-query retrieval.
 * Calls drill-down directly with the raw query.
 * Returns flat results array, trajectory, tokens_saved_estimate.
 */
export async function performFind(
  request: FindRequest
): Promise<FindResponse> {
  const { query, scope, max_results, min_score } = request;

  const { candidates, trajectory } = await drillDown(
    query,
    scope,
    max_results,
    min_score
  );

  const taggedResults = candidatesToResults(candidates, max_results, min_score, scope);
  const results: SearchResult[] = taggedResults.map(({ context_type: _, ...rest }) => rest);
  const tokensSaved = await calculateTokensSaved(candidates);

  return {
    results,
    trajectory,
    tokens_saved_estimate: tokensSaved,
  };
}

/**
 * Multi-query retrieval with intent-decomposed sub-queries.
 *
 * Every sub-query (including memory-type) routes through S3 Vectors
 * drill-down. Memory records live under viking://user/memories/ as
 * regular context items, so drill-down finds them exactly like any
 * other hierarchy. The v1-stable plan deletes the AgentCore Memory
 * parallel namespace entirely.
 */
export async function performSearch(
  request: SearchRequest,
  subQueries: SubQuery[]
): Promise<SearchResponse> {
  const { max_results, min_score } = request;

  // Execute drill-down for every sub-query in parallel.
  const drillResults = subQueries.length > 0
    ? await Promise.all(
        subQueries.map((sq) =>
          drillDown(sq.query, undefined, max_results, min_score)
        )
      )
    : [];

  // Merge candidates (dedup by URI, highest score wins)
  const mergedCandidates = new Map<string, Candidate>();
  const mergedTrajectory: TrajectoryStep[] = [];

  for (const dr of drillResults) {
    for (const [uri, candidate] of dr.candidates) {
      const existing = mergedCandidates.get(uri);
      if (!existing || candidate.score > existing.score) {
        mergedCandidates.set(uri, candidate);
      }
    }
    mergedTrajectory.push(...dr.trajectory);
  }

  const taggedResults = candidatesToResults(
    mergedCandidates,
    max_results,
    min_score
  );

  // Group by context_type
  const { memories, resources, skills } = groupByContextType(taggedResults);

  const tokensSaved = await calculateTokensSaved(mergedCandidates);

  return {
    memories,
    resources,
    skills,
    query_plan: subQueries,
    trajectory: mergedTrajectory,
    reason: null,
    tokens_saved_estimate: tokensSaved,
  };
}
