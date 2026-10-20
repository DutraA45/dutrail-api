import request from 'supertest';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';

const DEV_FRONTEND = 'http://localhost:4200';
const OTHER_ALLOWED = 'https://staging.dutrail.test';

/**
 * CORS_ORIGINS: só as origens listadas recebem Access-Control-Allow-Origin
 * (com credentials). O FRONTEND_URL não entra no CORS.
 */
describe('CORS por CORS_ORIGINS (e2e)', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  describe('vazio (frontend e API na mesma origem)', () => {
    let t: TestApp;
    const http = () => request(t.app.getHttpServer());

    beforeAll(async () => {
      // FRONTEND_URL continua o do .env.test (localhost:4200): não pode
      // liberar essa origem por tabela.
      t = await createAppWithEnv({ CORS_ORIGINS: '' });
    });

    afterAll(async () => {
      await t.close();
    });

    it('preflight de outra origem não recebe nenhum header de CORS', async () => {
      const res = await http()
        .options('/api/auth/refresh')
        .set('Origin', DEV_FRONTEND)
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('request simples com Origin: atendida, sem Access-Control-Allow-Origin', async () => {
      const res = await http()
        .get('/api/health')
        .set('Origin', DEV_FRONTEND)
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('request sem Origin (app nativo, curl) funciona normalmente', async () => {
      await http().get('/api/health').expect(200, { status: 'ok' });
      await http().get('/api/me').expect(401);
    });
  });

  describe('com duas origens', () => {
    let t: TestApp;
    const http = () => request(t.app.getHttpServer());

    beforeAll(async () => {
      t = await createAppWithEnv({
        CORS_ORIGINS: `${DEV_FRONTEND},${OTHER_ALLOWED}`,
      });
    });

    afterAll(async () => {
      await t.close();
    });

    it.each([DEV_FRONTEND, OTHER_ALLOWED])(
      '%s: preflight reflete a origem e libera credentials',
      async (origin) => {
        const res = await http()
          .options('/api/auth/refresh')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST')
          .expect(204);

        expect(res.headers['access-control-allow-origin']).toBe(origin);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
      },
    );

    it('origem fora da lista: sem Access-Control-Allow-Origin nem credentials', async () => {
      const res = await http()
        .options('/api/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('request sem Origin (app nativo, curl) funciona normalmente', async () => {
      const res = await http().get('/api/health').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  it('"*" é recusado no boot', async () => {
    try {
      await expect(createAppWithEnv({ CORS_ORIGINS: '*' })).rejects.toThrow(
        /CORS_ORIGINS não aceita "\*"/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
