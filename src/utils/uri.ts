import { z } from 'zod';
import {
  VIKING_PROTOCOL,
  VIKING_SCOPES,
  MAX_URI_DEPTH,
  type VikingScope,
  type ParsedUri,
} from '../types/uri';

/** Regex for valid URI path segments: lowercase alphanumeric, hyphens, underscores, dots */
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Zod schema for a single path segment */
const segmentSchema = z.string().regex(SEGMENT_PATTERN, 'Invalid segment: lowercase alphanumeric, hyphens, underscores, and dots only');

/**
 * Checks whether a URI string represents a directory (ends with /).
 */
export function isDirectoryUri(uri: string): boolean {
  return uri.endsWith('/');
}

/**
 * Validates a viking:// URI string.
 *
 * Rules:
 * - Must start with 'viking://'
 * - Scope must be one of: resources, user, agent, session
 * - Path segments: lowercase alphanumeric + hyphens + dots only
 * - No double slashes in path (after viking://)
 * - Max depth: 10 levels (scope counts as 1)
 */
export function validateUri(uri: string): { success: true; data: string } | { success: false; error: string } {
  if (!uri) {
    return { success: false, error: 'URI must not be empty' };
  }

  if (!uri.startsWith(VIKING_PROTOCOL)) {
    return { success: false, error: `URI must start with ${VIKING_PROTOCOL}` };
  }

  const afterProtocol = uri.slice(VIKING_PROTOCOL.length);

  // Check for double slashes in the path portion
  if (afterProtocol.includes('//')) {
    return { success: false, error: 'URI must not contain double slashes in path' };
  }

  // Split into parts and extract scope
  const parts = afterProtocol.split('/');
  const scope = parts[0];

  if (!scope || !(VIKING_SCOPES as readonly string[]).includes(scope)) {
    return { success: false, error: `Invalid scope: must be one of ${VIKING_SCOPES.join(', ')}` };
  }

  // Get path segments (exclude scope and trailing empty string from trailing slash)
  const segments = parts.slice(1).filter((s) => s !== '');

  // Validate each segment
  for (const segment of segments) {
    const result = segmentSchema.safeParse(segment);
    if (!result.success) {
      return { success: false, error: `Invalid path segment '${segment}': lowercase alphanumeric, hyphens, and dots only` };
    }
  }

  // Calculate depth: scope = 1, each segment adds 1
  const depth = 1 + segments.length;
  if (depth > MAX_URI_DEPTH) {
    return { success: false, error: `URI depth ${depth} exceeds maximum of ${MAX_URI_DEPTH}` };
  }

  return { success: true, data: uri };
}

/**
 * Validates a viking:// directory URI (must end with /).
 */
export function validateDirectoryUri(uri: string): { success: true; data: string } | { success: false; error: string } {
  const result = validateUri(uri);
  if (!result.success) {
    return result;
  }

  if (!isDirectoryUri(uri)) {
    return { success: false, error: 'Directory URI must end with /' };
  }

  return { success: true, data: uri };
}

/**
 * Returns the parent URI of the given URI, or null for root.
 *
 * Examples:
 * - viking://resources/docs/auth/ -> viking://resources/docs/
 * - viking://resources/ -> viking://
 * - viking:// -> null
 */
export function getParentUri(uri: string): string | null {
  // Root has no parent
  if (uri === VIKING_PROTOCOL || uri === 'viking://') {
    return null;
  }

  // Remove trailing slash for uniform processing
  const normalized = uri.endsWith('/') ? uri.slice(0, -1) : uri;
  const lastSlash = normalized.lastIndexOf('/');

  if (lastSlash === -1) {
    return null;
  }

  const parent = normalized.slice(0, lastSlash + 1);

  // If parent is just "viking://", that's the root
  if (parent === VIKING_PROTOCOL) {
    return VIKING_PROTOCOL;
  }

  return parent;
}

/**
 * Parses a validated viking:// URI into its components.
 *
 * @throws {Error} if the URI is invalid
 */
export function parseUri(uri: string): ParsedUri {
  const validation = validateUri(uri);
  if (!validation.success) {
    throw new Error(`Invalid URI: ${validation.error}`);
  }

  const afterProtocol = uri.slice(VIKING_PROTOCOL.length);
  const parts = afterProtocol.split('/');
  const scope = parts[0] as VikingScope;
  const segments = parts.slice(1).filter((s) => s !== '');
  const depth = 1 + segments.length;

  return {
    raw: uri,
    scope,
    segments,
    isDirectory: isDirectoryUri(uri),
    depth,
    parentUri: getParentUri(uri),
  };
}
