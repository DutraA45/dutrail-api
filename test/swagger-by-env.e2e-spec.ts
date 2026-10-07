import { readFileSync } from 'node:fs';
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

    it('o documento bate com o código (tipos, nulos e respostas)', async () => {
      const { body: doc } = await http().get('/docs-json').expect(200);
      const schemas = doc.components.schemas;

      // name e avatarUrl: sempre presentes, string ou null.
      const user = schemas.UserResponseDto;
      for (const field of ['name', 'avatarUrl']) {
        expect(user.properties[field]).toMatchObject({
          type: 'string',
          nullable: true,
        });
      }
      expect(user.required).toEqual(
        expect.arrayContaining(['name', 'avatarUrl']),
      );

      // Inteiros como integer; metros continuam number.
      const activity = schemas.ActivityResponseDto.properties;
      for (const field of [
        'elapsedTimeSeconds',
        'movingTimeSeconds',
        'averageHeartRateBpm',
        'maxHeartRateBpm',
        'calories',
      ]) {
        expect(activity[field].type, field).toBe('integer');
      }
      expect(activity.distanceMeters.type).toBe('number');
      expect(schemas.ErrorResponseDto.properties.statusCode.type).toBe(
        'integer',
      );
      expect(doc.paths['/activities'].get.parameters[0]).toMatchObject({
        name: 'limit',
        schema: { type: 'integer' },
      });

      // TTLs são padrões configuráveis, sem valor fixo na descrição.
      expect(JSON.stringify(doc)).not.toMatch(/15 min|7 dias/);

      // 429 também nas rotas que só têm o limite global.
      for (const [path, method] of [
        ['/me', 'get'],
        ['/activities', 'get'],
        ['/activities/{id}', 'get'],
      ]) {
        expect(Object.keys(doc.paths[path][method].responses)).toContain('429');
      }

      // logout-all ignora o corpo: o 400 é só do header.
      expect(
        doc.paths['/auth/logout-all'].post.responses['400'].description,
      ).not.toMatch(/body|corpo/i);
      expect(
        doc.paths['/auth/logout'].post.responses['401'].description,
      ).toMatch(/expirado/);
    });

    it('docs/openapi.json está em dia (npm run openapi:generate)', async () => {
      const res = await http().get('/docs-json').expect(200);
      const snapshot: unknown = JSON.parse(
        readFileSync('docs/openapi.json', 'utf8'),
      );
      expect(res.body).toEqual(snapshot);
    });
  });
});
