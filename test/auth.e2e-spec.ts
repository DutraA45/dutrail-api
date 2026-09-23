import request from 'supertest';
import { fakeGoogle, makeGoogleProfile } from './fakes/fake-google.strategy.js';
import {
  CLIENT_TYPES,
  createClient,
  sentCookies,
  setCookie,
  setCookieRaw,
  type TestClient,
} from './utils/client.js';
import { createTestApp, TestApp } from './utils/create-app.js';

const credentials = {
  email: 'ana@example.com',
  password: 'S3nh@Forte!',
  name: 'Ana',
};
const loginBody = { email: credentials.email, password: credentials.password };

/**
 * Cenários que dependem do transporte do refresh token rodam para os DOIS
 * tipos de cliente. A lógica de negócio (rotação, reuso, revogação) é a mesma;
 * só muda por onde o token entra e sai.
 */
describe.each(CLIENT_TYPES)(
  'Auth via X-Client-Type: %s (e2e)',
  (clientType) => {
    let t: TestApp;
    let c: TestClient;

    beforeAll(async () => {
      t = await createTestApp();
    });

    beforeEach(async () => {
      await t.resetDb();
      fakeGoogle.profile = null;
      // Cliente novo a cada teste: cookie jar limpo, como um browser recém-aberto.
      c = createClient(t.app, clientType);
    });

    afterAll(async () => {
      await t.close();
    });

    async function signup(body: Record<string, unknown> = credentials) {
      const res = await c.post('/auth/signup').send(body).expect(201);
      return res;
    }

    describe('POST /auth/signup', () => {
      it('cria o usuário e entrega o refresh token apenas pelo canal do cliente', async () => {
        const res = await signup();

        expect(res.body.accessToken).toBeTypeOf('string');
        expect(res.body.user).toMatchObject({
          email: 'ana@example.com',
          hasPassword: true,
        });
        c.expectTokenChannel(res);
        expect(JSON.stringify(res.body)).not.toMatch(
          /password|Hash|S3nh@Forte/,
        );
      });

      it('o refresh token entregue funciona', async () => {
        const res = await signup();
        const token = c.refreshTokenOf(res)!;

        await c.refresh(token).expect(200);
      });
    });

    describe('POST /auth/login', () => {
      beforeEach(() => signup());

      it('entrega o refresh token apenas pelo canal do cliente', async () => {
        const res = await c.post('/auth/login').send(loginBody).expect(200);

        expect(res.body.user.email).toBe('ana@example.com');
        c.expectTokenChannel(res);
      });

      it('mantém o 401 genérico para credenciais erradas', async () => {
        const res = await c
          .post('/auth/login')
          .send({ email: credentials.email, password: 'errada123' })
          .expect(401);
        expect(res.body.message).toBe('Invalid credentials');
        expect(res.headers['set-cookie']).toBeUndefined();
      });
    });

    describe('POST /auth/refresh', () => {
      it('rotaciona: emite par novo, invalida o antigo e não devolve o usuário', async () => {
        const first = await signup();
        const firstToken = c.refreshTokenOf(first)!;

        const res = await c.refresh(firstToken).expect(200);

        expect(res.body.accessToken).toBeTypeOf('string');
        expect(res.body.user).toBeUndefined();
        c.expectTokenChannel(res);
        expect(c.refreshTokenOf(res)).not.toBe(firstToken);

        // O access token novo funciona...
        await c
          .get('/me')
          .set('Authorization', `Bearer ${res.body.accessToken}`)
          .expect(200);
        // ...e o refresh token antigo não.
        await c.refreshWith(firstToken).expect(401);
      });

      it('reuso de token rotacionado derruba todas as sessões', async () => {
        const first = await signup();
        const firstToken = c.refreshTokenOf(first)!;
        const second = await c.refresh(firstToken).expect(200);
        const secondToken = c.refreshTokenOf(second)!;

        const reuse = await c.refreshWith(firstToken).expect(401);
        expect(reuse.body.message).toBe('Refresh token reuse detected');

        await c.refreshWith(secondToken).expect(401);
        expect(
          await t.prisma.refreshToken.count({ where: { revokedAt: null } }),
        ).toBe(0);
      });

      it('401 quando o token não vem no canal do cliente', async () => {
        await signup();
        // web: sem cookie (jar vazio). mobile: sem refreshToken no corpo.
        const res = await request(t.app.getHttpServer())
          .post('/auth/refresh')
          .set('X-Client-Type', clientType)
          .expect(401);
        expect(res.body.message).toBe('Missing refresh token');
      });
    });

    describe('POST /auth/logout', () => {
      it('revoga a sessão e o token deixa de funcionar', async () => {
        const res = await signup();
        const token = c.refreshTokenOf(res)!;

        await c.logout(token).expect(204);
        await c.refreshWith(token).expect(401);
      });

      it('é idempotente', async () => {
        const res = await signup();
        const token = c.refreshTokenOf(res)!;

        await c.logout(token).expect(204);
        await c.logout(token).expect(204);
      });

      it('não afeta as outras sessões do usuário', async () => {
        await signup();
        const a = await c.post('/auth/login').send(loginBody).expect(200);
        const aToken = c.refreshTokenOf(a)!;
        // Segunda sessão: outro cliente (outro cookie jar / outro token).
        const other = createClient(t.app, clientType);
        const b = await other.post('/auth/login').send(loginBody).expect(200);
        const bToken = other.refreshTokenOf(b)!;

        await c.logout(aToken).expect(204);
        await c.refreshWith(aToken).expect(401);
        await other.refreshWith(bToken).expect(200);
      });
    });

    describe('Google OAuth (strategy mockada)', () => {
      it('troca o código por tokens no canal do cliente', async () => {
        fakeGoogle.profile = makeGoogleProfile({});
        const callback = await c
          .get('/auth/google/callback?code=google-code')
          .expect(302);
        const code = new URL(callback.headers.location).searchParams.get(
          'code',
        )!;
        // O redirect do Google nunca carrega token, em nenhum dos fluxos.
        expect(callback.headers.location).not.toMatch(/token/i);
        expect(callback.headers['set-cookie']).toBeUndefined();

        const res = await c
          .post('/auth/google/exchange')
          .send({ code })
          .expect(200);

        expect(res.body.user).toMatchObject({
          email: 'google@example.com',
          hasPassword: false,
        });
        c.expectTokenChannel(res);
        await c.refresh(c.refreshTokenOf(res)!).expect(200);
      });
    });

    describe('X-Client-Type', () => {
      it.each([
        ['/auth/signup', credentials],
        ['/auth/login', loginBody],
        ['/auth/refresh', {}],
        ['/auth/logout', {}],
        ['/auth/google/exchange', { code: 'a'.repeat(43) }],
      ])('400 em %s sem o header', async (url, body) => {
        const res = await request(t.app.getHttpServer())
          .post(url)
          .send(body)
          .expect(400);
        expect(res.body.message).toContain('x-client-type');
      });

      it('400 com valor inválido', async () => {
        const res = await request(t.app.getHttpServer())
          .post('/auth/login')
          .set('X-Client-Type', 'desktop')
          .send(loginBody)
          .expect(400);
        expect(res.body.message).toContain('must be one of');
      });
    });
  },
);

describe('Transporte do refresh token: regras de canal (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => t.resetDb());

  afterAll(async () => {
    await t.close();
  });

  const http = () => request(t.app.getHttpServer());

  async function signupAs(clientType: 'web' | 'mobile') {
    return http()
      .post('/auth/signup')
      .set('X-Client-Type', clientType)
      .send(credentials)
      .expect(201);
  }

  it('web: cookie com HttpOnly, Path=/auth, SameSite=Lax e maxAge de 7 dias', async () => {
    const res = await signupAs('web');
    const cookie = setCookieRaw(res)!;

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/auth');
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    // NODE_ENV=test -> sem Secure, senão o cookie não sobreviveria em http://.
    expect(cookie).not.toContain('Secure');
  });

  it('web: 400 se o refresh token vier no corpo (canal errado)', async () => {
    const signup = await signupAs('web');
    const token = setCookie(signup)!;

    const res = await http()
      .post('/auth/refresh')
      .set('X-Client-Type', 'web')
      .set('Cookie', `refreshToken=${token}`)
      .send({ refreshToken: token })
      .expect(400);
    expect(res.body.message).toContain('must not be sent in the request body');

    // A sessão continua intacta: a request foi rejeitada antes da rotação.
    await http()
      .post('/auth/refresh')
      .set('X-Client-Type', 'web')
      .set('Cookie', `refreshToken=${token}`)
      .expect(200);
  });

  it('mobile: 400 se um cookie de refresh acompanhar a request', async () => {
    const signup = await signupAs('mobile');
    const token = signup.body.refreshToken as string;

    const res = await http()
      .post('/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .set('Cookie', `refreshToken=${token}`)
      .send({ refreshToken: token })
      .expect(400);
    expect(res.body.message).toContain('must not be sent when');
  });

  it('web: logout limpa o cookie com as mesmas opções do set', async () => {
    const signup = await signupAs('web');
    const token = setCookie(signup)!;

    const res = await http()
      .post('/auth/logout')
      .set('X-Client-Type', 'web')
      .set('Cookie', `refreshToken=${token}`)
      .expect(204);

    const cleared = setCookieRaw(res)!;
    expect(cleared).toMatch(/^refreshToken=;/);
    expect(cleared).toContain('Path=/auth');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
  });

  it('web: logout sem cookie é 204 (sessão já encerrada), e ainda limpa o cookie', async () => {
    const res = await http()
      .post('/auth/logout')
      .set('X-Client-Type', 'web')
      .expect(204);
    expect(setCookieRaw(res)).toMatch(/^refreshToken=;/);
  });

  it('mobile: nenhuma rota emite Set-Cookie', async () => {
    const signup = await signupAs('mobile');
    expect(signup.headers['set-cookie']).toBeUndefined();

    const refresh = await http()
      .post('/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: signup.body.refreshToken })
      .expect(200);
    expect(refresh.headers['set-cookie']).toBeUndefined();

    const logout = await http()
      .post('/auth/logout')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: refresh.body.refreshToken })
      .expect(204);
    expect(logout.headers['set-cookie']).toBeUndefined();
  });

  it('o cookie do fluxo web não acompanha requests fora de /auth', async () => {
    // Path=/auth: o browser não manda o refresh token para as rotas de negócio.
    const agent = request.agent(t.app.getHttpServer());
    const signup = await agent
      .post('/auth/signup')
      .set('X-Client-Type', 'web')
      .send(credentials)
      .expect(201);

    const me = await agent
      .get('/me')
      .set('Authorization', `Bearer ${signup.body.accessToken}`)
      .expect(200);
    expect(sentCookies(me)).toBe('');

    // Já em /auth/refresh o mesmo jar envia o cookie.
    const refresh = await agent
      .post('/auth/refresh')
      .set('X-Client-Type', 'web')
      .expect(200);
    expect(sentCookies(refresh)).toContain('refreshToken=');
  });

  it('CORS: preflight permite credenciais, a origem do frontend e o header X-Client-Type', async () => {
    // Sem isso o browser nem envia a request real do fluxo web: o cookie exige
    // Allow-Credentials, e o header customizado exige estar em Allow-Headers.
    const res = await http()
      .options('/auth/refresh')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-client-type,content-type')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(
      res.headers['access-control-allow-headers']?.toLowerCase(),
    ).toContain('x-client-type');
  });

  it('CORS: nunca reflete uma origem arbitrária de volta', async () => {
    const res = await http()
      .options('/auth/refresh')
      .set('Origin', 'https://atacante.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-client-type');

    // A origem permitida é fixa (FRONTEND_URL). Como ela não corresponde à
    // origem que pediu, o browser bloqueia a resposta do atacante.
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'https://atacante.example',
    );
  });

  it('web e mobile compartilham a mesma sessão no banco (só o canal difere)', async () => {
    await signupAs('web');
    expect(await t.prisma.refreshToken.count()).toBe(1);

    const row = await t.prisma.refreshToken.findFirstOrThrow();
    // O banco guarda apenas o hash, igual para os dois transportes.
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.revokedAt).toBeNull();
  });
});

describe('Rotas independentes do client type (e2e)', () => {
  let t: TestApp;

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

  const http = () => request(t.app.getHttpServer());
  const mobile = () => createClient(t.app, 'mobile');

  it('GET /auth/google redireciona sem exigir o header', async () => {
    const res = await http().get('/auth/google').expect(302);
    expect(res.headers.location).toContain('accounts.google.com');
  });

  it('GET /me não exige X-Client-Type', async () => {
    const c = mobile();
    const signup = await c.post('/auth/signup').send(credentials).expect(201);

    const res = await http()
      .get('/me')
      .set('Authorization', `Bearer ${signup.body.accessToken}`)
      .expect(200);
    expect(res.body).toMatchObject({
      email: 'ana@example.com',
      hasPassword: true,
    });
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it.each([
    ['sem token', undefined],
    ['token adulterado', 'a.b.c'],
  ])('GET /me retorna 401 %s', async (_label, token) => {
    const req = http().get('/me');
    if (token) req.set('Authorization', `Bearer ${token}`);
    await req.expect(401);
  });

  it('GET /me retorna 401 com refresh token no lugar do access token', async () => {
    const c = mobile();
    const signup = await c.post('/auth/signup').send(credentials).expect(201);
    await http()
      .get('/me')
      .set('Authorization', `Bearer ${signup.body.refreshToken}`)
      .expect(401);
  });

  it('retorna 409 para email já cadastrado', async () => {
    const c = mobile();
    await c.post('/auth/signup').send(credentials).expect(201);
    const res = await c.post('/auth/signup').send(credentials).expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Email already registered',
      path: '/auth/signup',
      timestamp: expect.any(String),
    });
  });

  it('retorna 400 com a lista de erros de validação', async () => {
    const res = await mobile()
      .post('/auth/signup')
      .send({ email: 'nao-e-email', password: '123', isAdmin: true })
      .expect(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([
        expect.stringContaining('email must be an email'),
        expect.stringContaining('password must be longer'),
        expect.stringContaining('isAdmin should not exist'),
      ]),
    );
  });

  it('rejeita refresh token que não é JWT e código de troca com tamanho errado', async () => {
    const c = mobile();
    await c
      .post('/auth/refresh')
      .send({ refreshToken: 'nao-e-jwt' })
      .expect(400);
    await c.post('/auth/google/exchange').send({ code: 'curto' }).expect(400);
  });

  it('vincula a conta Google a um usuário existente com o mesmo email', async () => {
    const c = mobile();
    await c.post('/auth/signup').send(credentials).expect(201);

    fakeGoogle.profile = makeGoogleProfile({
      email: 'Ana@Example.com',
      id: 'google-id-ana',
    });
    const callback = await http()
      .get('/auth/google/callback?code=google-code')
      .expect(302);
    const code = new URL(callback.headers.location).searchParams.get('code')!;
    const res = await c
      .post('/auth/google/exchange')
      .send({ code })
      .expect(200);

    expect(res.body.user).toMatchObject({
      email: 'ana@example.com',
      name: 'Ana',
      emailVerified: true,
      hasPassword: true,
    });
    expect(await t.prisma.user.count()).toBe(1);
  });

  it('recusa vincular quando o Google não verificou o email', async () => {
    const c = mobile();
    await c.post('/auth/signup').send(credentials).expect(201);
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

  it('rejeita código de troca já usado ou expirado', async () => {
    const c = mobile();
    fakeGoogle.profile = makeGoogleProfile({});
    const callback = await http()
      .get('/auth/google/callback?code=google-code')
      .expect(302);
    const code = new URL(callback.headers.location).searchParams.get('code')!;

    await c.post('/auth/google/exchange').send({ code }).expect(200);
    await c.post('/auth/google/exchange').send({ code }).expect(401);

    fakeGoogle.profile = makeGoogleProfile({
      email: 'outro@example.com',
      id: 'g-2',
    });
    const second = await http()
      .get('/auth/google/callback?code=google-code')
      .expect(302);
    const expiring = new URL(second.headers.location).searchParams.get('code')!;
    await t.prisma.oAuthExchangeCode.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await c.post('/auth/google/exchange').send({ code: expiring }).expect(401);
  });

  describe('Swagger', () => {
    it('documenta o header, os dois formatos de corpo e os erros', async () => {
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
      expect(res.body.paths['/me'].get.security).toEqual([{ bearer: [] }]);

      // X-Client-Type documentado como header obrigatório nas rotas de token.
      const loginHeaders = res.body.paths['/auth/login'].post.parameters;
      expect(loginHeaders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'X-Client-Type',
            in: 'header',
            required: true,
          }),
        ]),
      );

      // O corpo varia por cliente: oneOf com os dois formatos.
      const loginSchema =
        res.body.paths['/auth/login'].post.responses['200'].content[
          'application/json'
        ].schema;
      expect(loginSchema.oneOf).toEqual([
        { $ref: '#/components/schemas/AuthWebResponseDto' },
        { $ref: '#/components/schemas/AuthMobileResponseDto' },
      ]);
      const refreshSchema =
        res.body.paths['/auth/refresh'].post.responses['200'].content[
          'application/json'
        ].schema;
      expect(refreshSchema.oneOf).toEqual([
        { $ref: '#/components/schemas/AccessTokenDto' },
        { $ref: '#/components/schemas/TokenPairDto' },
      ]);

      // Só o schema mobile expõe refreshToken.
      expect(
        res.body.components.schemas.AuthMobileResponseDto.properties,
      ).toHaveProperty('refreshToken');
      expect(
        res.body.components.schemas.AuthWebResponseDto.properties,
      ).not.toHaveProperty('refreshToken');

      expect(res.body.paths['/auth/login'].post.responses).toHaveProperty(
        '401',
      );
      expect(res.body.paths['/auth/login'].post.responses).toHaveProperty(
        '429',
      );
      expect(res.body.paths['/auth/refresh'].post.responses).toHaveProperty(
        '400',
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
    const post = () =>
      request(t.app.getHttpServer())
        .post('/auth/login')
        .set('X-Client-Type', 'mobile')
        .send(body);

    for (let i = 0; i < 10; i++) {
      await post().expect(401);
    }
    const res = await post().expect(429);
    expect(res.body).toMatchObject({ statusCode: 429, path: '/auth/login' });
    expect(res.body.message).toMatch(/too many requests/i);
  });
});
