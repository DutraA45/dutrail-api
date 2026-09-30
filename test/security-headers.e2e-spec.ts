import request from 'supertest';
import { createTestApp, TestApp } from './utils/create-app.js';
import { csp, expectSecurityHeaders } from './utils/security-headers.js';

// FRONTEND_URL do .env.test.
const FRONTEND = 'http://localhost:4200';

describe('Cabeçalhos de segurança (e2e)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
    await t.resetDb();
  });

  afterAll(async () => {
    await t.close();
  });

  describe('respostas da API', () => {
    it('2xx: presentes', async () => {
      const res = await http()
        .post('/auth/signup')
        .set('X-Client-Type', 'mobile')
        .send({
          email: 'ana@example.com',
          password: 'S3nh@Forte!',
          name: 'Ana',
        })
        .expect(201);
      expectSecurityHeaders(res);
    });

    it('401: presentes', async () => {
      const res = await http().get('/me').expect(401);
      expectSecurityHeaders(res);
    });

    it('404: presentes', async () => {
      const res = await http().get('/nao-existe').expect(404);
      expectSecurityHeaders(res);
    });

    it('CSP padrão do helmet, com frame-ancestors none', async () => {
      const res = await http().get('/me').expect(401);
      const directives = csp(res);

      expect(directives.get('default-src')).toBe("'self'");
      expect(directives.get('script-src')).toBe("'self'");
      expect(directives.get('object-src')).toBe("'none'");
      expect(directives.get('frame-ancestors')).toBe("'none'");
      expect(directives.has('upgrade-insecure-requests')).toBe(true);
    });

    it('/docs-yaml não recebe a CSP da Swagger UI', async () => {
      const res = await http().get('/docs-yaml').expect(200);
      expect(csp(res).has('upgrade-insecure-requests')).toBe(true);
    });

    it('CORP same-origin (padrão do helmet) acompanha as respostas CORS', async () => {
      // O browser só aplica o CORP a requests no-cors; o fetch do Angular é
      // CORS e é liberado pelo Access-Control-Allow-Origin.
      const res = await http().get('/me').set('Origin', FRONTEND).expect(401);
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    });
  });

  describe('Swagger (NODE_ENV=test)', () => {
    it('/docs serve a UI com CSP que permite seus assets', async () => {
      const res = await http().get('/docs').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expectSecurityHeaders(res);

      const directives = csp(res);
      // Scripts e CSS vêm do próprio /docs; os <style> inline são permitidos.
      expect(directives.get('script-src')).toBe("'self'");
      expect(directives.get('style-src')).toContain("'unsafe-inline'");
      expect(directives.get('img-src')).toContain('data:');
      expect(directives.get('frame-ancestors')).toBe("'none'");
      // Em http:// o upgrade quebraria os assets e o "Try it out".
      expect(directives.has('upgrade-insecure-requests')).toBe(false);
      // A página não usa script inline: nada que a CSP bloquearia.
      expect(res.text).not.toMatch(/<script>(?!\s*<\/script>)/);
    });

    it.each([
      '/docs/swagger-ui-bundle.js',
      '/docs/swagger-ui-standalone-preset.js',
      '/docs/swagger-ui-init.js',
      '/docs/swagger-ui.css',
    ])('%s (asset da UI) responde 200', async (path) => {
      const res = await http().get(path).expect(200);
      expectSecurityHeaders(res);
    });

    it('/docs-json responde o documento OpenAPI', async () => {
      const res = await http().get('/docs-json').expect(200);
      expect(res.body.openapi).toBeTypeOf('string');
      expect(res.body.paths).toHaveProperty('/auth/login');
      expectSecurityHeaders(res);
    });
  });

  describe('CORS', () => {
    it('origem permitida: reflete a origem e libera credentials', async () => {
      const res = await http()
        .options('/auth/refresh')
        .set('Origin', FRONTEND)
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);

      expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expectSecurityHeaders(res);
    });

    it('origem não permitida: não reflete a origem', async () => {
      const res = await http()
        .options('/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).not.toBe(
        'https://evil.example',
      );
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('origem não permitida em request simples: não reflete a origem', async () => {
      const res = await http()
        .get('/me')
        .set('Origin', 'https://evil.example')
        .expect(401);

      expect(res.headers['access-control-allow-origin']).not.toBe(
        'https://evil.example',
      );
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });
  });
});
