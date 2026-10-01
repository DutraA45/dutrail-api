import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';
import { claimsOf, signWithSecretOf } from './utils/jwt.js';

const credentials = {
  email: 'ana@example.com',
  password: 'S3nh@Forte!',
  name: 'Ana',
};

/**
 * TTLs e emissor dos JWTs fora do .env.test (A-14), subindo a app de verdade:
 * a validação roda no boot, pelo ConfigModule.
 */
describe('Configuração dos JWTs por ambiente (e2e)', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  describe('TTLs no teto (1h e 30d) e JWT_ISSUER próprio', () => {
    const ISSUER = 'https://api.dutrail.test';
    let t: TestApp;
    const http = () => request(t.app.getHttpServer());

    beforeAll(async () => {
      t = await createAppWithEnv({
        JWT_ACCESS_TTL: '1h',
        JWT_REFRESH_TTL: '30d',
        JWT_ISSUER: ISSUER,
      });
    });

    beforeEach(() => t.resetDb());

    afterAll(async () => {
      await t.close();
    });

    it('sobe e emite tokens com esses prazos e esse emissor', async () => {
      const res = await http()
        .post('/auth/signup')
        .set('X-Client-Type', 'mobile')
        .send(credentials)
        .expect(201);

      const jwt = new JwtService();
      const access = jwt.decode<{ iat: number; exp: number; iss: string }>(
        res.body.accessToken,
      );
      const refresh = jwt.decode<{ iat: number; exp: number; iss: string }>(
        res.body.refreshToken,
      );
      expect(access.exp - access.iat).toBe(3600);
      expect(refresh.exp - refresh.iat).toBe(30 * 86_400);
      expect(access.iss).toBe(ISSUER);
      expect(refresh.iss).toBe(ISSUER);

      await http()
        .get('/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
    });

    it('recusa access token com o emissor padrão (dutrail-api)', async () => {
      const res = await http()
        .post('/auth/signup')
        .set('X-Client-Type', 'mobile')
        .send(credentials)
        .expect(201);
      const payload = { sub: res.body.user.id, email: credentials.email };

      await http()
        .get('/me')
        .set(
          'Authorization',
          `Bearer ${signWithSecretOf('access', payload, claimsOf('access'))}`,
        )
        .expect(401);
      await http()
        .get('/me')
        .set(
          'Authorization',
          `Bearer ${signWithSecretOf('access', payload, { ...claimsOf('access'), issuer: ISSUER })}`,
        )
        .expect(200);
    });
  });

  // Depois de uma app válida de propósito. O ConfigModule.forRoot é async: a
  // rejeição nasce ao importar o AppModule e só ganha handler no compile().
  // Com o transform do Vite ainda frio (primeiro import do arquivo), passam
  // ticks suficientes para o Node marcá-la como "unhandled rejection".
  describe('boot recusa TTL inválido, dizendo a variável e o motivo', () => {
    it.each([
      [
        'JWT_ACCESS_TTL',
        '15',
        'JWT_ACCESS_TTL deve ser um inteiro positivo seguido de s, m, h ou d',
      ],
      ['JWT_ACCESS_TTL', '2h', 'JWT_ACCESS_TTL não pode passar de 1h'],
      ['JWT_REFRESH_TTL', '31d', 'JWT_REFRESH_TTL não pode passar de 30d'],
    ])('%s=%s', async (name, value, message) => {
      await expect(createAppWithEnv({ [name]: value })).rejects.toThrow(
        message,
      );
    });
  });
});
