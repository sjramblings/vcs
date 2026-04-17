import { z } from 'zod';
import { validateUri, validateDirectoryUri } from './uri';

// ── Session & filesystem mutation schemas ──

/**
 * Schema for POST /sessions (create session). Empty body accepted.
 */
export const createSessionSchema = z.object({});

/**
 * Discriminated union for message parts (text, context, tool).
 */
const textPartSchema = z.object({
  type: z.literal('text'),
  content: z.string().min(1),
});

const contextPartSchema = z.object({
  type: z.literal('context'),
  uri: z.string().min(1),
  abstract: z.string(),
});

const toolPartSchema = z.object({
  type: z.literal('tool'),
  name: z.string().min(1),
  input: z.unknown(),
  output: z.unknown(),
  success: z.boolean(),
});

const messagePartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  contextPartSchema,
  toolPartSchema,
]);

/**
 * Schema for POST /sessions/:id/messages (add message).
 */
export const addMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  parts: z.array(messagePartSchema).min(1),
});

/**
 * Schema for POST /sessions/:id/used (record context usage).
 */
export const usedSchema = z.object({
  uris: z.array(z.string().min(1)).min(1),
  skill: z.string().optional(),
});

/**
 * Schema for DELETE /fs/rm (remove resource).
 */
export const rmRequestSchema = z.object({
  uri: z.string().refine((v) => validateUri(v).success, {
    message: 'Invalid URI',
  }),
});

/**
 * Schema for POST /fs/mv (move/rename resource).
 */
export const mvRequestSchema = z.object({
  from_uri: z.string().refine((v) => validateUri(v).success, {
    message: 'Invalid source URI',
  }),
  to_uri: z.string().refine((v) => validateUri(v).success, {
    message: 'Invalid destination URI',
  }),
});

/**
 * Schema for POST /search/find request body.
 */
export const findRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  scope: z.string().refine((v) => validateUri(v).success, {
    message: 'Invalid scope URI',
  }).optional(),
  max_results: z.number().int().min(1).max(20).default(5),
  min_score: z.number().min(0).max(1).default(0.2),
});

/**
 * Schema for POST /search/search request body.
 */
export const searchRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  session_id: z.string().min(1),
  max_results: z.number().int().min(1).max(20).default(5),
  min_score: z.number().min(0).max(1).default(0.2),
});

/**
 * Schema for GET /fs/ls request parameters.
 */
export const lsRequestSchema = z.object({
  uri: z.string().refine((v) => validateDirectoryUri(v).success, {
    message: 'Invalid directory URI',
  }),
  nextToken: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(50).optional(),
});

/**
 * Schema for GET /fs/tree request parameters.
 */
export const treeRequestSchema = z.object({
  uri: z.string().refine((v) => validateDirectoryUri(v).success, {
    message: 'Invalid directory URI',
  }),
  depth: z.number().int().min(1).max(10).default(3).optional(),
});

/**
 * Schema for GET /fs/read request parameters.
 */
export const readRequestSchema = z.object({
  uri: z.string().refine((v) => validateUri(v).success, {
    message: 'Invalid URI',
  }),
  level: z.coerce.number().int().min(0).max(2),
});

/**
 * Schema for POST /fs/mkdir request body.
 */
export const mkdirRequestSchema = z.object({
  uri: z.string().refine((v) => validateDirectoryUri(v).success, {
    message: 'Invalid directory URI',
  }),
  context_type: z.enum(['resource', 'memory', 'skill', 'session', 'wiki', 'schema', 'log']).optional(),
});

/**
 * Schema for POST /resources ingest request body.
 */
export const ingestRequestSchema = z.object({
  content_base64: z.string().min(1, 'Content must not be empty'),
  uri_prefix: z.string().refine((v) => validateDirectoryUri(v).success, {
    message: 'uri_prefix must be a valid directory URI',
  }),
  filename: z.string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'filename must be lowercase alphanumeric with hyphens, dots, and underscores'),
  instruction: z.string().max(1000).optional(),
});
