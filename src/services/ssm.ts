import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

const client = new SSMClient({});
const cache = new Map<string, string>();
let cacheLoaded = false;

/**
 * Loads all SSM parameters in a single batch call and caches them.
 * Subsequent calls are no-ops (module-level cache persists across warm invocations).
 */
export async function loadAllParams(names: readonly string[]): Promise<void> {
  if (cacheLoaded) return;

  const { Parameters } = await client.send(
    new GetParametersCommand({ Names: [...names] })
  );

  for (const param of Parameters ?? []) {
    if (param.Name && param.Value) {
      cache.set(param.Name, param.Value);
    }
  }

  cacheLoaded = true;
}

/**
 * Retrieves a single SSM parameter value from cache.
 * Falls back to a single-param fetch if not cached.
 */
export async function getParam(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  // Single param fallback for params not loaded in batch
  const { Parameters } = await client.send(
    new GetParametersCommand({ Names: [name] })
  );

  const param = Parameters?.[0];
  if (!param?.Value) {
    throw new Error(`SSM parameter not found: ${name}`);
  }

  cache.set(name, param.Value);
  return param.Value;
}
