export type ContextType = 'resource' | 'memory' | 'skill' | 'session' | 'wiki' | 'schema' | 'log';
export type ProcessingStatus = 'pending' | 'processing' | 'ready';
export type MemoryCategory = 'profile' | 'preferences' | 'entities' | 'events' | 'cases' | 'patterns';

export interface ContextItem {
  uri: string;
  level: number;
  parent_uri: string;
  context_type: ContextType;
  category?: MemoryCategory;
  content?: string;
  s3_key?: string;
  is_directory: boolean;
  processing_status: ProcessingStatus;
  active_count?: number;
  last_rolled_up_at?: string;
  created_at: string;
  updated_at: string;
  ttl?: number;
}
