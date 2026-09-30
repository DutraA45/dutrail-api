import request from 'supertest';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';
import { csp, expectSecurityHeaders } from './utils/security-headers.js';

/** Sobe a app com outro NODE_ENV (A-10). */
function createAppWithNodeEnv(
  nodeEnv: 'development' | 'production',
): Promise<TestApp> {
  return createAppWithEnv({ NODE_ENV: nodeEnv });
}

describe('Swagger por NODE_ENV (e2e)', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  describe('NODE_ENV=production', () => {
    let t: TestApp;
    const http = () => request(t.app.getHttpServer());

    beforeAll(async () => {
      t = await createAppWithNodeEnv('production');
    });

    afterAll(async () => {
      await t.close();
    });

    it.each([
      '/docs',
      '/docs/',
      '/docs-json',
      '/docs-yaml',
      '/docs/swagger-ui-init.js',
      '/docs/swagger-ui-bundle.js',
    ])('%s responde 404', async (path) => {
      const res = await http().get(path).expect(404);
      expectSecurityHeaders(res);
      // Sem Swagger não há CSP relaxada: o 404 leva a CSP da API.
      expect(csp(res).has('upgrade-insecure-requests')).toBe(true);
    });

    it('a API continua respondendo com os cabeçalhos', async () => {
      const res = await http().get('/me').expect(401);
      expectSecurityHeaders(res);
    });
  });

  describe('NODE_ENV=development', () => {
    let t: TestApp;
    const http = () => request(t.app.getHttpServer());

    beforeAll(async () => {
      t = await createAppWithNodeEnv('development');
    });

    afterAll(async () => {
      await t.close();
    });

    it('/docs serve a UI com a CSP própria', async () => {
      const res = await http().get('/docs').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expectSecurityHeaders(res);
      expect(csp(res).has('upgrade-insecure-requests')).toBe(false);
    });

    it('/docs-json responde o documento OpenAPI', async () => {
      const res = await http().get('/docs-json').expect(200);
      expect(res.body.openapi).toBeTypeOf('string');
    });
  });
});
