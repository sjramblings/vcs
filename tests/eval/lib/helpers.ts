import http from 'k6/http';
import { API_URL, authHeaders } from './config.ts';

export function postJson(path: string, body: object, tag: string) {
  return http.post(`${API_URL}${path}`, JSON.stringify(body), {
    headers: authHeaders(),
    tags: { endpoint: tag },
  });
}

export function getWithParams(path: string, params: Record<string, string>, tag: string) {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = query ? `${API_URL}${path}?${query}` : `${API_URL}${path}`;
  return http.get(url, {
    headers: authHeaders(),
    tags: { endpoint: tag },
  });
}

export function deleteJson(path: string, body: object, tag: string) {
  return http.del(`${API_URL}${path}`, JSON.stringify(body), {
    headers: authHeaders(),
    tags: { endpoint: tag },
  });
}
