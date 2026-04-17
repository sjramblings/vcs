export interface LsRequest {
  uri: string;
  nextToken?: string;
  limit?: number;
}

export interface LsResponseItem {
  uri: string;
  is_directory: boolean;
  context_type: string;
  created_at: string;
  updated_at: string;
}

export interface LsResponse {
  items: LsResponseItem[];
  nextToken?: string;
}

export interface TreeNode {
  uri: string;
  is_directory: boolean;
  context_type: string;
  children?: TreeNode[];
}

export interface TreeRequest {
  uri: string;
  depth?: number;
}

export interface TreeResponse {
  root: TreeNode;
}

export interface ReadRequest {
  uri: string;
  level: number;
}

export interface ReadResponse {
  uri: string;
  level: number;
  content: string;
  tokens?: number;
}

export interface MkdirRequest {
  uri: string;
  context_type?: string;
}

export interface MkdirResponse {
  uri: string;
  created: boolean;
}

export interface ErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}
