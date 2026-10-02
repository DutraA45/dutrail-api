import { JwtService } from '@nestjs/jwt';
import { argon2id, hash as argon2Hash } from 'argon2';
import request from 'supertest';
import { PasswordService } from '../src/auth/password.service.js';
import { createClient, type TestClient } from './utils/client.js';
import { createTestApp, TestApp } from './utils/create-app.js';
import { claimsOf, signWithSecretOf } from './utils/jwt.js';

const email = 'ana@example.com';
// "é" pré-composto (U+00E9) e "e" + acento agudo combinante (U+0301).
const COMPOSED = 'café-S3nh@';
const DECOMPOSED = 'café-S3nh@';
// "ｐａｓｓ" de largura total; o NFKC a leva para "pass".
const FULL_WIDTH = 'ｐａｓｓ-1234';
const HALF_WIDTH = 'pass-1234';

describe('Senha normalizada em NFKC (A-09, e2e)', () => {
  let t: TestApp;
  let c: TestClient;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await t.resetDb();
    c = createClient(t.app, 'mobile');
  });

  afterAll(async () => {
    await t.close();
  });

  const signup = (password: string) =>
    c.post('/auth/signup').send({ email, password });
  const login = (password: string, as = email) =>
    c.post('/auth/login').send({ email: as, password });
  const storedHash = async () =>
    (await t.prisma.user.findUniqueOrThrow({ where: { email } })).passwordHash;

  it.each([
    ['pré-composto', COMPOSED, DECOMPOSED],
    ['decomposto', DECOMPOSED, COMPOSED],
    ['de largura total', FULL_WIDTH, HALF_WIDTH],
    ['de largura normal', HALF_WIDTH, FULL_WIDTH],
  ])(
    'cadastro com a forma %s: login com qualquer forma equivalente',
    async (_label, signupForm, otherForm) => {
      expect(signupForm).not.toBe(otherForm);
      await signup(signupForm).expect(201);

      await login(signupForm).expect(200);
      await login(otherForm).expect(200);
    },
  );

  it('hash legado (senha bruta decomposta, sem NFKC): entra e o hash vira o da forma normalizada', async () => {
    const legacyHash = await argon2Hash(DECOMPOSED, { type: argon2id });
    await t.prisma.user.create({ data: { email, passwordHash: legacyHash } });
    // Antes do rehash, só a forma exata do cadastro entra.
    await login(COMPOSED).expect(401);
    expect(await storedHash()).toBe(legacyHash);

    await login(DECOMPOSED).expect(200);

    const upgraded = await storedHash();
    expect(upgraded).not.toBe(legacyHash);
    expect(upgraded).toMatch(/^\$argon2id\$/);
    // O hash novo é da forma normalizada: confere sem fallback.
    await expect(
      new PasswordService().verify(upgraded!, DECOMPOSED.normalize('NFKC')),
    ).resolves.toEqual({ valid: true, needsRehash: false });
    // E agora as duas formas entram.
    await login(COMPOSED).expect(200);
    await login(DECOMPOSED).expect(200);
    expect(await storedHash()).toBe(upgraded);
  });

  it('rejeita no cadastro a senha que passa de 128 caracteres depois do NFKC', async () => {
    // 64 caracteres na entrada (o DTO aceita); 256 depois do NFKC.
    const res = await signup('㍿'.repeat(64)).expect(400);

    expect(res.body.message).toEqual([
      'password must be shorter than or equal to 128 characters after Unicode normalization (NFKC)',
    ]);
    expect(await t.prisma.user.count()).toBe(0);
  });

  it('aceita exatamente 128 caracteres depois do NFKC, e o teto do DTO continua valendo', async () => {
    await signup('㍿'.repeat(32)).expect(201);
    await t.resetDb();
    await signup('a'.repeat(129)).expect(400);
  });

  describe('email inexistente × senha errada', () => {
    beforeEach(() => signup(COMPOSED).expect(201));

    // Sem o que muda de uma request para outra.
    const stable = ({ timestamp: _t, ...body }: Record<string, unknown>) =>
      body;

    it.each([
      ['já normalizada (1 argon2)', 'errada-123', 1],
      ['não normalizada (2 argon2: normalizada e bruta)', 'erradé-123', 2],
    ])(
      'senha %s: mesma resposta e mesmo número de verificações',
      async (_label, password, verifies) => {
        const passwords = t.app.get(PasswordService);
        const spy = vi.spyOn(
          passwords as unknown as { matches: () => Promise<boolean> },
          'matches',
        );

        const wrong = await login(password).expect(401);
        const wrongCalls = spy.mock.calls.length;
        spy.mockClear();
        const unknown = await login(password, 'ninguem@example.com').expect(
          401,
        );
        const unknownCalls = spy.mock.calls.length;
        spy.mockRestore();

        expect(stable(unknown.body)).toEqual(stable(wrong.body));
        expect(wrong.body.message).toBe('Invalid credentials');
        expect(wrongCalls).toBe(verifies);
        expect(unknownCalls).toBe(verifies);
      },
    );
  });
});

describe('Access token sem email (A-21, e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await t.resetDb();
  });

  afterAll(async () => {
    await t.close();
  });

  const bearer = (path: string, token: string) =>
    request(t.app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);

  it('o payload emitido no signup, login e refresh não tem email; as rotas protegidas funcionam', async () => {
    const c = createClient(t.app, 'mobile');
    const signup = await c
      .post('/auth/signup')
      .send({ email, password: 'S3nh@Forte!' })
      .expect(201);
    const login = await c
      .post('/auth/login')
      .send({ email, password: 'S3nh@Forte!' })
      .expect(200);
    const refresh = await c.refresh(login.body.refreshToken).expect(200);

    for (const { accessToken } of [signup.body, login.body, refresh.body]) {
      const payload = new JwtService().decode<Record<string, unknown>>(
        accessToken as string,
      );
      expect(payload.sub).toBe(signup.body.user.id);
      expect(payload).not.toHaveProperty('email');
      expect(JSON.stringify(payload)).not.toContain(email);

      const me = await bearer('/me', accessToken as string).expect(200);
      expect(me.body.email).toBe(email);
      await bearer('/activities', accessToken as string).expect(200);
    }
  });

  it('access token emitido antes (com email no payload) continua válido', async () => {
    const res = await createClient(t.app, 'mobile')
      .post('/auth/signup')
      .send({ email, password: 'S3nh@Forte!' })
      .expect(201);
    const legacy = signWithSecretOf(
      'access',
      { sub: res.body.user.id, email },
      claimsOf('access'),
    );

    const me = await bearer('/me', legacy).expect(200);
    expect(me.body.id).toBe(res.body.user.id);
  });
});
