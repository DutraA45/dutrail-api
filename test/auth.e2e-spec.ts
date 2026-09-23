import request from 'supertest';
import { fakeGoogle, makeGoogleProfile } from './fakes/fake-google.strategy.js';
import { createTestApp, TestApp } from './utils/create-app.js';

const credentials = {
  email: 'ana@example.com',
  password: 'S3nh@Forte!',
  name: 'Ana',
};
const loginBody = { email: credentials.email, password: credentials.password };

describe('Auth (e2e)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await t.resetDb();
    fakeGoogle.profile = null;
  });

  afterAll(async () => {
    await t.close();
  });

  async function signup(body: Record<string, unknown> = credentials) {
    const res = await http().post('/auth/signup').send(body).expect(201);
    return res.body as {
      accessToken: string;
      refreshToken: string;
      user: Record<string, unknown>;
    };
  }

  describe('POST /auth/signup', () => {
    it('cria o usuário, devolve tokens e nunca expõe a senha/hash', async () => {
      const res = await http()
        .post('/auth/signup')
        .send({ ...credentials, email: '  Ana@Example.COM ' })
        .expect(201);

      expect(res.body.accessToken).toBeTypeOf('string');
      expect(res.body.refreshToken).toBeTypeOf('string');
      expect(res.body.user).toMatchObject({
        email: 'ana@example.com', // normalizado
        name: 'Ana',
        emailVerified: false,
        hasPassword: true,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|Hash|S3nh@Forte/);

      const stored = await t.prisma.user.findUnique({
        where: { email: 'ana@example.com' },
      });
      expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('retorna 409 para email já cadastrado, no formato padrão de erro', async () => {
      await signup();
      const res = await http()
        .post('/auth/signup')
        .send(credentials)
        .expect(409);

      expect(res.body).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: 'Email already registered',
        path: '/auth/signup',
        timestamp: expect.any(String),
      });
    });

    it('retorna 400 com a lista de erros de validação', async () => {
      const res = await http()
        .post('/auth/signup')
        .send({ email: 'nao-e-email', password: '123', isAdmin: true })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.message).toEqual(
        expect.arrayContaining([
          expect.stringContaining('email must be an email'),
          expect.stringContaining('password must be longer'),
          expect.stringContaining('isAdmin should not exist'),
        ]),
      );
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(() => signup());

    it('devolve tokens com credenciais corretas', async () => {
      const res = await http()
        .post('/auth/login')
        .send({ email: 'ANA@example.com', password: credentials.password })
        .expect(200);
      expect(res.body.accessToken).toBeTypeOf('string');
      expect(res.body.refreshToken).toBeTypeOf('string');
      expect(res.body.user.email).toBe('ana@example.com');
    });

    it.each([
      ['senha errada', { email: credentials.email, password: 'errada123' }],
      [
        'email inexistente',
        { email: 'ninguem@example.com', password: credentials.password },
      ],
    ])('retorna o mesmo 401 para %s', async (_label, body) => {
      const res = await http().post('/auth/login').send(body).expect(401);
      expect(res.body.message).toBe('Invalid credentials');
    });
  });

  describe('GET /me (rota protegida)', () => {
    it('retorna 401 sem token', async () => {
      const res = await http().get('/me').expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        error: 'Unauthorized',
        path: '/me',
      });
    });

    it('retorna 401 com token adulterado', async () => {
      const { accessToken } = await signup();
      const [header, payload] = accessToken.split('.');
      await http()
        .get('/me')
        .set('Authorization', `Bearer ${header}.${payload}.assinaturafalsa`)
        .expect(401);
    });

    it('retorna 401 usando o refresh token no lugar do access token', async () => {
      const { refreshToken } = await signup();
      await http()
        .get('/me')
        .set('Authorization', `Bearer ${refreshToken}`)
        .expect(401);
    });

    it('retorna o usuário com access token válido', async () => {
      const { accessToken } = await signup();
      const res = await http()
        .get('/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body).toMatchObject({
        email: 'ana@example.com',
        name: 'Ana',
        hasPassword: true,
      });
      expect(res.body).not.toHaveProperty('passwordHash');
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotaciona: devolve par novo e invalida o antigo', async () => {
      const first = await signup();

      const res = await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);
      expect(res.body.refreshToken).not.toBe(first.refreshToken);
      expect(res.body).not.toHaveProperty('user');

      // O novo funciona...
      await http()
        .get('/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      // ...e o antigo não.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);
    });

    it('reuso de token rotacionado derruba todas as sessões do usuário', async () => {
      const first = await signup();
      const second = (
        await http()
          .post('/auth/refresh')
          .send({ refreshToken: first.refreshToken })
          .expect(200)
      ).body;

      // Ataque: o token antigo (vazado) é reapresentado.
      const res = await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);
      expect(res.body.message).toBe('Refresh token reuse detected');

      // O token "novo" (que o usuário legítimo tinha) também morreu.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: second.refreshToken })
        .expect(401);

      const active = await t.prisma.refreshToken.count({
        where: { revokedAt: null },
      });
      expect(active).toBe(0);
    });

    it('retorna 400 para body inválido e 401 para JWT com outra assinatura', async () => {
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: 'nao-e-jwt' })
        .expect(400);
      await http().post('/auth/refresh').send({}).expect(400);

      const forged =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4IiwianRpIjoieSJ9.p7Z7t1o0v4b0M6Jc8aC2XhY0mHqf1aP2Z3bW4c5D6E8';
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: forged })
        .expect(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('invalida o refresh token e é idempotente', async () => {
      const { refreshToken, accessToken } = await signup();

      await http().post('/auth/logout').send({ refreshToken }).expect(204);
      await http().post('/auth/refresh').send({ refreshToken }).expect(401);
      // Segundo logout com o mesmo token: nada a fazer, continua 204.
      await http().post('/auth/logout').send({ refreshToken }).expect(204);

      // Access token é stateless: continua válido até expirar.
      await http()
        .get('/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('logout de uma sessão não afeta as outras', async () => {
      await signup();
      const a = (await http().post('/auth/login').send(loginBody).expect(200))
        .body;
      const b = (await http().post('/auth/login').send(loginBody).expect(200))
        .body;

      await http()
        .post('/auth/logout')
        .send({ refreshToken: a.refreshToken })
        .expect(204);
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: a.refreshToken })
        .expect(401);
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: b.refreshToken })
        .expect(200);
    });
  });

  describe('Google OAuth (strategy mockada)', () => {
    it('GET /auth/google redireciona para o Google', async () => {
      const res = await http().get('/auth/google').expect(302);
      expect(res.headers.location).toContain('accounts.google.com');
    });

    /** Simula o retorno do Google e troca o código por tokens. */
    async function loginViaGoogle(profile = makeGoogleProfile({})) {
      fakeGoogle.profile = profile;
      const callback = await http()
        .get('/auth/google/callback?code=google-code')
        .expect(302);

      const location = new URL(callback.headers.location);
      expect(`${location.origin}${location.pathname}`).toBe(
        'http://localhost:4200/auth/callback',
      );
      const code = location.searchParams.get('code');
      expect(code).toHaveLength(43);
      // Nenhum token na URL de redirect.
      expect(callback.headers.location).not.toMatch(/token/i);

      const exchange = await http()
        .post('/auth/google/exchange')
        .send({ code })
        .expect(200);
      return { code: code!, ...exchange.body };
    }

    it('primeiro login cria o usuário sem senha e entrega tokens via código de troca', async () => {
      const result = await loginViaGoogle();

      expect(result.user).toMatchObject({
        email: 'google@example.com',
        name: 'Google User',
        avatarUrl: 'https://lh3.googleusercontent.com/fake.png',
        emailVerified: true,
        hasPassword: false,
      });
      await http()
        .get('/me')
        .set('Authorization', `Bearer ${result.accessToken}`)
        .expect(200);

      // O código é de uso único.
      await http()
        .post('/auth/google/exchange')
        .send({ code: result.code })
        .expect(401);

      // Conta só-Google não aceita login por senha.
      await http()
        .post('/auth/login')
        .send({ email: 'google@example.com', password: 'qualquer1' })
        .expect(401);
    });

    it('vincula a conta Google a um usuário existente com o mesmo email', async () => {
      await signup(); // ana@example.com, com senha

      const result = await loginViaGoogle(
        makeGoogleProfile({ email: 'Ana@Example.com', id: 'google-id-ana' }),
      );

      expect(result.user).toMatchObject({
        email: 'ana@example.com',
        name: 'Ana', // mantém o nome original
        emailVerified: true, // agora verificado pelo Google
        hasPassword: true, // a senha continua funcionando
      });
      expect(await t.prisma.user.count()).toBe(1);
      const stored = await t.prisma.user.findUnique({
        where: { email: 'ana@example.com' },
      });
      expect(stored?.googleId).toBe('google-id-ana');

      // Segundo login pelo Google cai direto no usuário vinculado.
      const again = await loginViaGoogle(
        makeGoogleProfile({ email: 'ana@example.com', id: 'google-id-ana' }),
      );
      expect(again.user.id).toBe(result.user.id);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('recusa vincular quando o Google não verificou o email', async () => {
      await signup();
      fakeGoogle.profile = makeGoogleProfile({
        email: 'ana@example.com',
        verified: false,
      });

      const res = await http()
        .get('/auth/google/callback?code=google-code')
        .expect(401);
      expect(res.body.message).toContain('not verified');

      const stored = await t.prisma.user.findUnique({
        where: { email: 'ana@example.com' },
      });
      expect(stored?.googleId).toBeNull();
    });

    it('rejeita código de troca expirado', async () => {
      fakeGoogle.profile = makeGoogleProfile({});
      const callback = await http()
        .get('/auth/google/callback?code=google-code')
        .expect(302);
      const code = new URL(callback.headers.location).searchParams.get('code')!;

      await t.prisma.oAuthExchangeCode.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await http().post('/auth/google/exchange').send({ code }).expect(401);
    });

    it('rejeita código com formato inválido com 400 (sem consultar o banco)', async () => {
      await http()
        .post('/auth/google/exchange')
        .send({ code: 'curto' })
        .expect(400);
    });
  });

  describe('Swagger', () => {
    it('expõe a documentação em /docs e o JSON em /docs-json', async () => {
      await http().get('/docs').expect(200);
      const res = await http().get('/docs-json').expect(200);

      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining([
          '/auth/signup',
          '/auth/login',
          '/auth/refresh',
          '/auth/logout',
          '/auth/google',
          '/auth/google/exchange',
          '/me',
        ]),
      );
      // /me exige bearer na UI.
      expect(res.body.paths['/me'].get.security).toEqual([{ bearer: [] }]);
      // Erros documentados.
      expect(res.body.paths['/auth/login'].post.responses).toHaveProperty(
        '401',
      );
      expect(res.body.paths['/auth/login'].post.responses).toHaveProperty(
        '429',
      );
    });
  });
});

describe('Rate limiting (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ keepThrottling: true });
    await t.resetDb();
  });

  afterAll(async () => {
    await t.close();
  });

  it('bloqueia o login com 429 após 10 tentativas por minuto', async () => {
    const body = { email: 'x@example.com', password: 'qualquer1' };
    for (let i = 0; i < 10; i++) {
      await request(t.app.getHttpServer())
        .post('/auth/login')
        .send(body)
        .expect(401);
    }
    const res = await request(t.app.getHttpServer())
      .post('/auth/login')
      .send(body)
      .expect(429);
    expect(res.body).toMatchObject({ statusCode: 429, path: '/auth/login' });
    expect(res.body.message).toMatch(/too many requests/i);
  });
});
