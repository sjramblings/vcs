export type SessionStatus = 'active' | 'committed' | 'archived';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface TextPart {
  type: 'text';
  content: string;
}

export interface ContextPart {
  type: 'context';
  uri: string;
  abstract: string;
}

export interface ToolPart {
  type: 'tool';
  name: string;
  input?: unknown;
  output?: unknown;
  success: boolean;
}

export type MessagePart = TextPart | ContextPart | ToolPart;

export interface SessionEntry {
  session_id: string;
  entry_type_seq: string;
  role?: MessageRole;
  parts?: MessagePart[];
  timestamp: string;
  status?: SessionStatus;
  compression_summary?: string;
  msg_count?: number;
  uris?: string[];
  skill?: string;
}
