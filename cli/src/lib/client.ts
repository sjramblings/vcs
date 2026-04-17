import { resolveConfig } from './config.js';
import { status } from './output.js';
import { CliError } from './errors.js';

export interface RequestOptions {
  method?: string;
  body?: unknown;
  timeout?: number;
  retries?: number;
}

export async function apiCall(path: string, opts: RequestOptions = {}): Promise<Response> {
  const config = await resolveConfig();
  const timeout = opts.timeout ?? 30_000;
  const maxRetries = opts.retries ?? 1;

  const baseUrl = config.apiUrl.endsWith('/') ? config.apiUrl : config.apiUrl + '/';
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(cleanPath, baseUrl);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      status('Server error, retrying in 1s...');
      await new Promise(r => setTimeout(r, 1000));
    }

    try {
      const response = await fetch(url.toString(), {
        method: opts.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });

      if (response.status >= 500 && attempt < maxRetries) {
        continue;
      }

      return response;
    } catch (err: unknown) {
      if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new CliError('Request timed out', 2, 'Check VCS_API_URL or increase timeout');
      }
      throw err;
    }
  }

  // Unreachable but TypeScript needs it
  throw new Error('Request failed after retries');
}
