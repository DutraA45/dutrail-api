import request from 'supertest';
import {
  expectMaxAgeMatchesToken,
  setCookie,
  setCookieRaw,
} from './utils/client.js';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';

const credentials = {
  email: 'ana@example.com',
  password: 'S3nh@Forte!',
  name: 'Ana',
};

/**
 * Cookie do refresh token fora da configuração do .env.test (A-11): `Secure`
 * ligado e um JWT_REFRESH_TTL diferente dos 7 dias padrão. Com Secure, o
 * cookie jar do supertest não o reenviaria em http://, então o cookie vai
 * sempre explícito no header.
 */
describe('Cookie do refresh token por ambiente (e2e)', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  describe('COOKIE_SECURE=true e JWT_REFRESH_TTL=3d', () => {
    const THREE_DAYS_S = 3 * 24 * 60 * 60;
    let t: TestApp;
    const http = () => request(t.app.getHttpServer());

    beforeAll(async () => {
      t = await createAppWithEnv({
        COOKIE_SECURE: 'true',
        JWT_REFRESH_TTL: '3d',
      });
    });

    beforeEach(() => t.resetDb());

    afterAll(async () => {
      await t.close();
    });

    function signupWeb() {
      return http()
        .post('/auth/signup')
        .set('X-Client-Type', 'web')
        .send(credentials)
        .expect(201);
    }

    it('Set-Cookie traz Secure e Max-Age de 3 dias, o mesmo prazo gravado no banco', async () => {
      const res = await signupWeb();
      const cookie = setCookieRaw(res)!;

      expect(cookie).toMatch(/;\s*Secure/i);
      expectMaxAgeMatchesToken(res, THREE_DAYS_S);

      const stored = await t.prisma.refreshToken.findFirstOrThrow();
      const expires = Date.parse(/Expires=([^;]+)/.exec(cookie)![1]);
      expect(Math.abs(expires - stored.expiresAt.getTime())).toBeLessThan(1000);
    });

    it('o refresh emite o cookie novo com as mesmas flags e validade', async () => {
      const token = setCookie(await signupWeb())!;

      const res = await http()
        .post('/auth/refresh')
        .set('X-Client-Type', 'web')
        .set('Cookie', `refreshToken=${token}`)
        .expect(200);

      expect(setCookieRaw(res)).toMatch(/;\s*Secure/i);
      expectMaxAgeMatchesToken(res, THREE_DAYS_S);
    });

    it('logout limpa o cookie com as mesmas opções do set, inclusive Secure', async () => {
      const token = setCookie(await signupWeb())!;

      const res = await http()
        .post('/auth/logout')
        .set('X-Client-Type', 'web')
        .set('Cookie', `refreshToken=${token}`)
        .expect(204);

      const cleared = setCookieRaw(res)!;
      expect(cleared).toMatch(/^refreshToken=;/);
      expect(cleared).toContain('Path=/auth');
      expect(cleared).toContain('HttpOnly');
      expect(cleared).toMatch(/SameSite=Lax/i);
      expect(cleared).toMatch(/;\s*Secure/i);
      expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
      expect(cleared).not.toContain('Max-Age');
    });
  });

  describe('NODE_ENV=production', () => {
    it('recusa COOKIE_SECURE=false no boot, dizendo a variável e o motivo', async () => {
      const boot = createAppWithEnv({
        NODE_ENV: 'production',
        COOKIE_SECURE: 'false',
      });

      await expect(boot).rejects.toThrow(
        /COOKIE_SECURE não pode ser desligado em produção/,
      );
    });
  });
});
