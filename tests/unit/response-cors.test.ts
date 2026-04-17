import { ok, badRequest, notFound, internalError, created } from '../../src/utils/response';

describe('CORS Response Headers (INFR-02)', () => {
  test('ok() includes Access-Control-Allow-Origin: *', () => {
    const res = ok({ data: 'test' });
    expect(res.headers).toBeDefined();
    expect(res.headers!['Access-Control-Allow-Origin']).toBe('*');
  });

  test('ok() includes Access-Control-Allow-Methods', () => {
    const res = ok({ data: 'test' });
    expect(res.headers!['Access-Control-Allow-Methods']).toBe('GET,POST,DELETE,OPTIONS');
  });

  test('ok() includes Access-Control-Allow-Headers with X-Api-Key', () => {
    const res = ok({ data: 'test' });
    expect(res.headers!['Access-Control-Allow-Headers']).toContain('X-Api-Key');
  });

  test('badRequest() includes CORS headers', () => {
    const res = badRequest('error');
    expect(res.headers!['Access-Control-Allow-Origin']).toBe('*');
  });

  test('notFound() includes CORS headers', () => {
    const res = notFound('missing');
    expect(res.headers!['Access-Control-Allow-Origin']).toBe('*');
  });

  test('internalError() includes CORS headers', () => {
    const res = internalError();
    expect(res.headers!['Access-Control-Allow-Origin']).toBe('*');
  });

  test('created() includes CORS headers', () => {
    const res = created({ id: '1' });
    expect(res.headers!['Access-Control-Allow-Origin']).toBe('*');
  });
});
