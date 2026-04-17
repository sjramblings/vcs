export const API_URL = __ENV.VCS_API_URL;
export const API_KEY = __ENV.VCS_API_KEY;

export function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
  };
}
