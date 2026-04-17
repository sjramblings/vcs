export interface FindRequest {
  query: string;
  scope?: string;
  max_results: number;
  min_score: number;
}

export interface SearchRequest {
  query: string;
  session_id: string;
  max_results: number;
  min_score: number;
}

export interface SearchResult {
  uri: string;
  level: number;
  score: number;
  abstract: string;
}

export interface SubQuery {
  query: string;
  context_type: 'resource' | 'memory' | 'skill';
  intent: string;
  priority: number;
}

export interface IntentAnalysisResult {
  queries: SubQuery[];
}

export interface TrajectoryStep {
  step: number;
  action: 'global_search' | 'drill' | 'converged';
  uri?: string;
  candidates?: number;
  score?: number;
  rounds?: number;
}

export interface SearchResponse {
  memories: SearchResult[];
  resources: SearchResult[];
  skills: SearchResult[];
  query_plan: SubQuery[];
  trajectory: TrajectoryStep[];
  reason: string | null;
  tokens_saved_estimate: number;
}

export interface FindResponse {
  results: SearchResult[];
  trajectory: TrajectoryStep[];
  tokens_saved_estimate: number;
}
