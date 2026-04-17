export const VIKING_PROTOCOL = 'viking://';
export const VIKING_SCOPES = ['resources', 'user', 'agent', 'session', 'wiki', 'schema', 'log'] as const;
export type VikingScope = (typeof VIKING_SCOPES)[number];
export const MAX_URI_DEPTH = 10;
export const ROOT_URIS = [
  'viking://resources/',
  'viking://user/',
  'viking://agent/',
  'viking://session/',
  'viking://wiki/',
  'viking://schema/',
  'viking://log/',
] as const;

export interface ParsedUri {
  raw: string;
  scope: VikingScope;
  segments: string[];
  isDirectory: boolean;
  depth: number;
  parentUri: string | null;
}
