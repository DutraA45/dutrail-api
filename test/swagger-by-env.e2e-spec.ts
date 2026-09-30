import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import request from 'supertest';
import type { TestApp } from './utils/create-app.js';
import { csp, expectSecurityHeaders } from './utils/security-headers.js';

/**
 * Sobe a app com outro NODE_ENV (A-10). O ConfigModule lê o ambiente quando o
 * AppModule é importado, então o módulo é reimportado depois de trocar o env.
 *
 * Todas as variáveis vêm do .env.test (o process.env vence os arquivos, então o
 * .env de desenvolvimento, que o AppModule passa a ler fora de NODE_ENV=test,
 * não contribui com nada — em especial o DATABASE_URL). Em produção a
 * validação exige credenciais sem trechos de placeholder e segredos JWT de
 * 256 bits: geramos valores aleatórios só para este processo.
 */
async function createAppWithNodeEnv(
  nodeEnv: 'development' | 'production',
): Promise<TestApp> {
  vi.resetModules();
  vi.unstubAllEnvs();

  const env = parse(readFileSync('.env.test'));
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubEnv('NODE_ENV', nodeEnv);
  if (nodeEnv === 'production') {
    vi.stubEnv('JWT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('JWT_REFRESH_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('GOOGLE_CLIENT_SECRET', randomBytes(16).toString('hex'));
    vi.stubEnv('OCI_S3_SECRET_KEY', randomBytes(16).toString('hex'));
  }
  // Salvaguarda igual à do global-setup: nunca subir contra outro banco.
  expect(process.env.DATABASE_URL).toContain('test');

  const { createTestApp } = await import('./utils/create-app.js');
  return createTestApp();
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
