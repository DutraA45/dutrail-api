import type { Response } from 'supertest';

/**
 * Cabeçalhos que TODA resposta carrega, inclusive erros (A-06). O helmet é o
 * primeiro middleware, então 401/404 gerados depois também passam por ele.
 */
export function expectSecurityHeaders(res: Response): void {
  expect(res.headers['strict-transport-security']).toBe(
    'max-age=31536000; includeSubDomains',
  );
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['content-security-policy']).toContain(
    "frame-ancestors 'none'",
  );
  expect(res.headers['x-powered-by']).toBeUndefined();
}

/** Diretivas da CSP como mapa nome -> valor. */
export function csp(res: Response): Map<string, string> {
  const header = res.headers['content-security-policy'] as string;
  return new Map(
    header.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values.join(' ')];
    }),
  );
}
