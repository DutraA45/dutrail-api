import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type * as FakeGoogleModule from './fakes/fake-google.strategy.js';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';
import { claimsOf, signWithSecretOf } from './utils/jwt.js';
import {
  captureNestLogs,
  type LogCapture,
  type SecurityLine,
} from './utils/log-capture.js';

/**
 * Log de eventos de segurança (A-07) contra fluxos reais.
 *
 * O .env.test desliga o log (SECURITY_LOG_ENABLED=false); aqui a app sobe com
 * ele ligado e TODA saída do Logger do Nest (log, warn, error...) é capturada,
 * não só a do SecurityLog: o teste de vazamento varre tudo.
 *
 * O createAppWithEnv reimporta os módulos (vi.resetModules), então o Logger e
 * o `fakeGoogle` precisam vir da MESMA instância que a app usa: são importados
 * depois de a app subir.
 */

const USER_AGENT = 'dutrail-e2e/1.0 (security-log)';
const credentials = {
  email: 'ana@example.com',
  password: 'S3nh@Forte!',
  name: 'Ana',
};
const WRONG_PASSWORD = 'S3nh@Errada!';

/** Tem de existir uma linha com o evento e os campos dados. */
function expectEvent(
  logs: LogCapture,
  fields: Partial<SecurityLine> & { event: string },
): SecurityLine {
  const match = logs
    .events()
    .find((e) =>
      Object.entries(fields).every(
        ([k, v]) => e[k as keyof SecurityLine] === v,
      ),
    );
  expect(
    match,
    `evento ${JSON.stringify(fields)} não emitido; emitidos: ${JSON.stringify(logs.events())}`,
  ).toBeDefined();
  return match!;
}

describe('Log de segurança (e2e)', () => {
  let t: TestApp;
  let logs: LogCapture;
  let fakeGoogle: typeof FakeGoogleModule.fakeGoogle;
  let makeGoogleProfile: typeof FakeGoogleModule.makeGoogleProfile;
  let google: typeof FakeGoogleModule;

  const http = () => request(t.app.getHttpServer());
  const post = (path: string, clientType: 'web' | 'mobile' = 'mobile') =>
    http()
      .post(path)
      .set('X-Client-Type', clientType)
      .set('User-Agent', USER_AGENT);
  /** Um browser novo (cookie jar) com o User-Agent dos testes. */
  const browser = () => request.agent(t.app.getHttpServer());

  const rowOf = (token: string) =>
    t.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    });

  async function signup(): Promise<{ userId: string; refreshToken: string }> {
    const res = await post('/auth/signup').send(credentials).expect(201);
    return {
      userId: res.body.user.id as string,
      refreshToken: res.body.refreshToken as string,
    };
  }

  /** Callback do Google com sucesso; devolve o código de troca do redirect. */
  async function googleCode(email = credentials.email): Promise<string> {
    fakeGoogle.profile = makeGoogleProfile({ email, id: 'google-id-ana' });
    const res = await google.googleCallback(t.app.getHttpServer(), USER_AGENT);
    return google.exchangeCodeOf(res.headers.location);
  }

  beforeAll(async () => {
    t = await createAppWithEnv({ SECURITY_LOG_ENABLED: 'true' });
    google = await import('./fakes/fake-google.strategy.js');
    ({ fakeGoogle, makeGoogleProfile } = google);
    logs = await captureNestLogs();
  });

  beforeEach(async () => {
    await t.resetDb();
    fakeGoogle.reset();
    logs.clear();
  });

  afterAll(async () => {
    logs.restore();
    await t.close();
    vi.unstubAllEnvs();
  });

  it('signup: userId, email mascarado, ip, user-agent, client type e timestamp ISO', async () => {
    const { userId } = await signup();

    const line = expectEvent(logs, { event: 'signup', level: 'log', userId });
    expect(line).toMatchObject({
      emailMasked: 'a***@e***.com',
      userAgent: USER_AGENT,
      clientType: 'mobile',
    });
    expect(line.ip).toMatch(/127\.0\.0\.1|::1/);
    expect(new Date(line.timestamp).toISOString()).toBe(line.timestamp);
  });

  it('login errado (senha e email) e login certo', async () => {
    const { userId } = await signup();
    logs.clear();

    await post('/auth/login')
      .send({ email: credentials.email, password: WRONG_PASSWORD })
      .expect(401);
    await post('/auth/login')
      .send({ email: 'ninguem@example.com', password: WRONG_PASSWORD })
      .expect(401);
    await post('/auth/login', 'web')
      .send({ email: credentials.email, password: credentials.password })
      .expect(200);

    expectEvent(logs, {
      event: 'login_failed',
      level: 'warn',
      reason: 'wrong_password',
      userId,
      emailMasked: 'a***@e***.com',
    });
    const unknown = expectEvent(logs, {
      event: 'login_failed',
      reason: 'unknown_email',
      emailMasked: 'n***@e***.com',
    });
    expect(unknown.userId).toBeUndefined();
    expectEvent(logs, {
      event: 'login_success',
      level: 'log',
      userId,
      clientType: 'web',
    });
  });

  it('refresh, janela de tolerância, reuso (com userId e familyId) e falhas de refresh', async () => {
    const { userId, refreshToken } = await signup();
    const { familyId } = await rowOf(refreshToken);
    logs.clear();

    await post('/auth/refresh').send({ refreshToken }).expect(200);
    expectEvent(logs, {
      event: 'refresh_success',
      level: 'log',
      userId,
      familyId,
    });

    // Retry com o mesmo token dentro da janela (resposta perdida).
    logs.clear();
    await post('/auth/refresh').send({ refreshToken }).expect(200);
    const grace = expectEvent(logs, {
      event: 'refresh_grace_used',
      level: 'warn',
      userId,
      familyId,
    });
    expect(grace.reason).toBeUndefined();

    // Terceira vez: a tolerância já foi usada, então é reuso.
    logs.clear();
    await post('/auth/refresh').send({ refreshToken }).expect(401);
    const reuse = expectEvent(logs, {
      event: 'refresh_reuse_detected',
      level: 'warn',
      userId,
      familyId,
    });
    expect(reuse.reason).toBeUndefined();
    expect(await t.prisma.refreshToken.count({ where: { familyId } })).toBe(0);

    await post('/auth/refresh').send({}).expect(401);
    expectEvent(logs, { event: 'refresh_invalid', reason: 'missing_token' });

    const forged = new JwtService().sign(
      { sub: userId, jti: 'x' },
      { secret: 'outro-segredo-qualquer-com-32-caracteres!' },
    );
    await post('/auth/refresh').send({ refreshToken: forged }).expect(401);
    expectEvent(logs, {
      event: 'refresh_invalid',
      level: 'warn',
      reason: 'invalid_jwt',
    });
  });

  it('A-18: toda recusa de refresh token recebido devolve a mesma mensagem; o motivo só vai para o log', async () => {
    const { userId, refreshToken } = await signup();
    const refresh = (body: object) =>
      post('/auth/refresh').send(body).expect(401);

    // Rotaciona duas vezes e desloga: o token original (cujo sucessor já
    // rotacionou) vira reuso; o do meio, cujo sucessor foi apagado no logout,
    // e o último, apagado, viram "não encontrado".
    const { familyId } = await rowOf(refreshToken);
    const rotated = await post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    const middle = rotated.body.refreshToken as string;
    const rotatedAgain = await post('/auth/refresh')
      .send({ refreshToken: middle })
      .expect(200);
    const loggedOut = rotatedAgain.body.refreshToken as string;
    await post('/auth/logout').send({ refreshToken: loggedOut }).expect(204);
    logs.clear();

    const cases = [
      {
        label: 'JWT inválido',
        token: new JwtService().sign(
          { sub: userId, jti: 'x' },
          {
            ...claimsOf('refresh'),
            secret: 'outro-segredo-qualquer-com-32-caracteres!',
            expiresIn: '1d',
          },
        ),
        expected: { event: 'refresh_invalid', reason: 'invalid_jwt' },
      },
      {
        label: 'JWT expirado',
        token: signWithSecretOf(
          'refresh',
          { sub: userId, jti: 'x' },
          { ...claimsOf('refresh'), expiresIn: -10 },
        ),
        expected: { event: 'refresh_invalid', reason: 'expired' },
      },
      {
        label: 'não encontrado',
        token: loggedOut,
        expected: { event: 'refresh_invalid', reason: 'not_found', userId },
      },
      {
        label: 'sucessor apagado no logout',
        token: middle,
        expected: {
          event: 'refresh_invalid',
          reason: 'not_found',
          userId,
          familyId,
        },
      },
      {
        label: 'reuso',
        token: refreshToken,
        expected: { event: 'refresh_reuse_detected', userId, familyId },
      },
    ];

    for (const { label, token, expected } of cases) {
      logs.clear();
      const res = await refresh({ refreshToken: token });
      expect(res.body.message, label).toBe('Invalid refresh token');

      const line = expectEvent(logs, { ...expected, level: 'warn' });
      if (expected.event === 'refresh_reuse_detected') {
        expect(line.reason, label).toBeUndefined();
      }
      // Um evento de recusa por request, sem misturar motivos.
      expect(
        logs.events().filter((e) => e.event.startsWith('refresh_')),
        label,
      ).toHaveLength(1);
    }

    // Token ausente continua com mensagem própria.
    logs.clear();
    const missing = await refresh({});
    expect(missing.body.message).toBe('Missing refresh token');
    expect(missing.body.statusCode).toBe(401);
    expectEvent(logs, {
      event: 'refresh_invalid',
      level: 'warn',
      reason: 'missing_token',
    });
  });

  it('logout com e sem token', async () => {
    const { userId, refreshToken } = await signup();
    logs.clear();

    await post('/auth/logout').send({ refreshToken }).expect(204);
    const line = expectEvent(logs, { event: 'logout', level: 'log', userId });
    expect(line.reason).toBeUndefined();

    await post('/auth/logout', 'web').expect(204);
    expectEvent(logs, {
      event: 'logout',
      reason: 'no_token',
      clientType: 'web',
    });
  });

  it('troca de código inválido e troca bem-sucedida', async () => {
    await post('/auth/google/exchange')
      .send({ code: 'a'.repeat(43) })
      .expect(401);
    expectEvent(logs, {
      event: 'google_exchange_failed',
      level: 'warn',
      reason: 'not_found',
      clientType: 'mobile',
    });

    const code = await googleCode();
    const res = await post('/auth/google/exchange').send({ code }).expect(200);
    expectEvent(logs, {
      event: 'google_exchange_success',
      level: 'log',
      userId: res.body.user.id,
    });

    await post('/auth/google/exchange').send({ code }).expect(401);
    expectEvent(logs, { event: 'google_exchange_failed', reason: 'used' });
  });

  it('falhas do callback do Google (A-13): um reason fixo por desfecho, sem query, state ou verifier', async () => {
    const callbackIn = (agent: ReturnType<typeof browser>, path: string) =>
      agent.get(path).set('User-Agent', USER_AGENT).expect(302);
    const expectedReasons: string[] = [];
    const seen: string[] = [];

    // Sem cookie de state (login CSRF): state_mismatch.
    await callbackIn(
      browser(),
      google.callbackPath({
        code: 'c0de-sem-cookie',
        state: 'st4te-sem-cookie',
      }),
    );
    expectedReasons.push('state_mismatch');

    // Cancelamento: access_denied, sem a descrição do Google.
    const cancel = browser();
    const cancelled = await google.startGoogleLogin(cancel, USER_AGENT);
    seen.push(cancelled.state);
    await callbackIn(
      cancel,
      google.callbackPath({
        error: 'access_denied',
        error_description: 'descricao-do-google',
        state: cancelled.state,
      }),
    );
    expectedReasons.push('access_denied');

    // Email não verificado pelo Google.
    fakeGoogle.profile = makeGoogleProfile({ verified: false });
    await google.googleCallback(t.app.getHttpServer(), USER_AGENT);
    expectedReasons.push('email_not_verified');

    // `code` inválido (TokenError): callback_error, sem 500.
    const invalid = browser();
    const consent = await google.startGoogleLogin(invalid, USER_AGENT);
    seen.push(consent.state);
    await callbackIn(
      invalid,
      google.callbackPath({ code: 'c0de-invalido', state: consent.state }),
    );
    expectedReasons.push('callback_error');

    const failures = logs
      .events()
      .filter((e) => e.event === 'google_exchange_failed');
    expect(failures.map((f) => f.reason)).toEqual(expectedReasons);
    for (const line of failures) {
      expect(line).toMatchObject({ level: 'warn', userAgent: USER_AGENT });
    }
    // Nenhuma linha (de nenhum logger) é erro com stack nesses desfechos.
    expect(logs.lines.filter((l) => l.level === 'error')).toEqual([]);

    seen.push(
      ...fakeGoogle.tokenRequests.flatMap((r) => [r.code, r.codeVerifier!]),
    );
    const all = logs.lines.map((l) => l.text).join('\n');
    for (const value of [
      ...seen,
      'c0de-sem-cookie',
      'st4te-sem-cookie',
      'c0de-invalido',
      'descricao-do-google',
      '?code',
      '?error',
    ]) {
      expect(all).not.toContain(value);
    }
  });

  it('vinculação Google: takeover de conta não verificada (warn) e conta verificada (log)', async () => {
    const { userId } = await signup();
    await post('/auth/google/exchange')
      .send({ code: await googleCode() })
      .expect(200);

    expectEvent(logs, {
      event: 'google_link',
      level: 'warn',
      reason: 'unverified_takeover',
      userId,
    });

    // Outra conta, agora com email já verificado: vínculo sem takeover.
    await t.resetDb();
    logs.clear();
    const other = await signup();
    await t.prisma.user.update({
      where: { id: other.userId },
      data: { emailVerified: true },
    });
    await googleCode();

    expectEvent(logs, {
      event: 'google_link',
      level: 'log',
      reason: 'verified_account',
      userId: other.userId,
    });
  });

  it('nenhuma linha de log de um fluxo completo contém senha, token, código, hash, email em claro ou query string', async () => {
    const secrets: string[] = [credentials.password, WRONG_PASSWORD];

    // Signup e logins (web e mobile), incluindo falhas.
    const web = request.agent(t.app.getHttpServer());
    const webPost = (path: string) =>
      web.post(path).set('X-Client-Type', 'web').set('User-Agent', USER_AGENT);

    const signupRes = await post('/auth/signup').send(credentials).expect(201);
    secrets.push(signupRes.body.accessToken, signupRes.body.refreshToken);
    await post('/auth/login')
      .send({ email: credentials.email, password: WRONG_PASSWORD })
      .expect(401);
    const webLogin = await webPost('/auth/login')
      .send({ email: credentials.email, password: credentials.password })
      .expect(200);
    const cookieToken = /refreshToken=([^;]+)/.exec(
      String(webLogin.headers['set-cookie']),
    )![1];
    secrets.push(webLogin.body.accessToken, decodeURIComponent(cookieToken));

    // Refresh, retry dentro da janela, reuso e logout.
    const mobileRt = signupRes.body.refreshToken as string;
    const rotated = await post('/auth/refresh')
      .send({ refreshToken: mobileRt })
      .expect(200);
    secrets.push(rotated.body.accessToken, rotated.body.refreshToken);
    const graced = await post('/auth/refresh')
      .send({ refreshToken: mobileRt })
      .expect(200);
    secrets.push(graced.body.accessToken, graced.body.refreshToken);
    // Terceira vez: reuso, que apaga a família do mobile...
    await post('/auth/refresh').send({ refreshToken: mobileRt }).expect(401);
    // ...e só ela: a sessão web é outra família e continua valendo.
    const webRefreshed = await webPost('/auth/refresh').expect(200);
    const webCookie = /refreshToken=([^;]+)/.exec(
      String(webRefreshed.headers['set-cookie']),
    )![1];
    secrets.push(webRefreshed.body.accessToken, decodeURIComponent(webCookie));
    const relogin = await post('/auth/login')
      .send({ email: credentials.email, password: credentials.password })
      .expect(200);
    secrets.push(relogin.body.accessToken, relogin.body.refreshToken);
    await post('/auth/logout')
      .send({ refreshToken: relogin.body.refreshToken })
      .expect(204);
    // Token apagado no logout: "não encontrado", sem acionar o reuso.
    await post('/auth/refresh')
      .send({ refreshToken: relogin.body.refreshToken })
      .expect(401);
    expectEvent(logs, { event: 'refresh_invalid', reason: 'not_found' });

    // Google: callback com falha (sem cookie de state, e erro inesperado),
    // callback ok (takeover), troca válida e inválida.
    await http()
      .get(
        google.callbackPath({ code: 'g00gle-auth-c0de', state: '0auth-st4te' }),
      )
      .expect(302);
    await google.googleCallback(t.app.getHttpServer(), USER_AGENT);
    fakeGoogle.profile = makeGoogleProfile({
      email: credentials.email,
      id: 'google-id-ana',
    });
    const googleBrowser = browser();
    const consent = await google.startGoogleLogin(googleBrowser, USER_AGENT);
    const cb = await googleBrowser
      .get(google.callbackPath(consent))
      .set('User-Agent', USER_AGENT)
      .expect(302);
    const exchangeCode = google.exchangeCodeOf(cb.headers.location);
    // state, verifier e o cookie selado também são segredos (A-02).
    secrets.push(
      consent.state,
      consent.code,
      consent.stateCookie,
      ...fakeGoogle.tokenRequests.map((r) => r.codeVerifier!),
    );
    const exchanged = await post('/auth/google/exchange')
      .send({ code: exchangeCode })
      .expect(200);
    secrets.push(
      exchangeCode,
      exchanged.body.accessToken,
      exchanged.body.refreshToken,
    );
    await post('/auth/google/exchange')
      .send({ code: exchangeCode })
      .expect(401);

    // Os hashes guardados no banco também não podem aparecer.
    const signupUser = await t.prisma.user.findUniqueOrThrow({
      where: { email: credentials.email },
    });
    const tokenHashes = await t.prisma.refreshToken.findMany({
      select: { tokenHash: true },
    });
    secrets.push(
      ...tokenHashes.map((r) => r.tokenHash),
      createHash('sha256').update(exchangeCode).digest('hex'),
      createHash('sha256').update(credentials.email).digest('hex'),
    );
    if (signupUser.passwordHash) secrets.push(signupUser.passwordHash);
    // Hashes dos tokens que já sumiram do banco (família apagada no reuso,
    // logout) também.
    secrets.push(
      ...secrets
        .filter((s) => s.split('.').length === 3)
        .map((s) => createHash('sha256').update(s).digest('hex')),
    );

    // Sair de todos os dispositivos (A-08), depois de colher os hashes (o
    // logout-all apaga as linhas).
    const families = await t.prisma.refreshToken.findMany({
      where: { userId: signupUser.id },
      distinct: ['familyId'],
    });
    await post('/auth/logout-all', 'web')
      .set('Authorization', `Bearer ${exchanged.body.accessToken}`)
      .expect(204);
    expectEvent(logs, {
      event: 'logout_all',
      level: 'log',
      userId: signupUser.id,
      sessionsRemoved: families.length,
    });
    expect(families.length).toBeGreaterThan(0);

    // Cadastro repetido (409) e o limite de login por conta (A-03): a senha
    // certa recebe 429 depois de LOGIN_MAX_FAILURES falhas. A chave do limite
    // (SHA-256 do email) já está entre os segredos.
    await post('/auth/signup').send(credentials).expect(409);
    const conflict = expectEvent(logs, {
      event: 'signup_conflict',
      level: 'warn',
      userId: signupUser.id,
      emailMasked: 'a***@e***.com',
    });
    expect(conflict.reason).toBeUndefined();
    for (let i = 0; i < 5; i++) {
      await post('/auth/login')
        .send({ email: credentials.email, password: WRONG_PASSWORD })
        .expect(401);
    }
    await post('/auth/login')
      .send({ email: credentials.email, password: credentials.password })
      .expect(429);
    const accountLimit = expectEvent(logs, {
      event: 'rate_limited',
      level: 'warn',
      reason: 'account_login_limit',
      path: '/auth/login',
    });
    expect(accountLimit.emailMasked).toBeUndefined();

    // O fluxo emitiu de fato os eventos esperados...
    const emitted = new Set(logs.events().map((e) => e.event));
    for (const event of [
      'signup',
      'signup_conflict',
      'rate_limited',
      'login_failed',
      'login_success',
      'refresh_success',
      'refresh_grace_used',
      'refresh_reuse_detected',
      'refresh_invalid',
      'logout',
      'logout_all',
      'google_link',
      'google_exchange_success',
      'google_exchange_failed',
    ]) {
      expect(emitted, event).toContain(event);
    }

    // ...e nenhuma linha (de nenhum logger) carrega dado sensível.
    expect(secrets.every((s) => typeof s === 'string' && s.length > 0)).toBe(
      true,
    );
    expect(logs.lines.length).toBeGreaterThan(0);
    // Os eventos da família trazem userId e familyId (um uuid opaco).
    for (const event of ['refresh_grace_used', 'refresh_reuse_detected']) {
      const line = logs.events().find((e) => e.event === event)!;
      expect(line.level, event).toBe('warn');
      expect(line.userId, event).toBe(signupUser.id);
      expect(line.familyId, event).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }

    for (const { text } of logs.lines) {
      for (const secret of secrets) {
        expect(text, 'segredo encontrado no log').not.toContain(secret);
      }
      expect(text).not.toContain(credentials.email);
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // nenhum email em claro
      expect(text).not.toContain('g00gle-auth-c0de');
      expect(text).not.toContain('0auth-st4te');
      expect(text).not.toMatch(/\?[\w-]+=/); // nenhuma query string
    }
  });
});

describe('Log de segurança: rate limit (e2e)', () => {
  let t: TestApp;
  let logs: LogCapture;

  beforeAll(async () => {
    t = await createAppWithEnv(
      { SECURITY_LOG_ENABLED: 'true' },
      { keepThrottling: true },
    );
    await t.resetDb();
    logs = await captureNestLogs();
  });

  afterAll(async () => {
    logs.restore();
    await t.close();
    vi.unstubAllEnvs();
  });

  it('o 429 do throttler vira rate_limited, com a rota', async () => {
    // Um email por tentativa: o limite aqui é o por IP, não o por conta.
    const login = (i: number) =>
      request(t.app.getHttpServer())
        .post('/auth/login?origem=e2e')
        .set('X-Client-Type', 'mobile')
        .set('User-Agent', USER_AGENT)
        .send({ email: `x${i}@example.com`, password: 'qualquer1' });

    for (let i = 0; i < 10; i++) {
      await login(i).expect(401);
    }
    const res = await login(10).expect(429);
    // A resposta ao cliente é a mesma de antes.
    expect(res.body).toMatchObject({
      statusCode: 429,
      path: '/auth/login?origem=e2e',
    });

    const limited = logs.events().filter((e) => e.event === 'rate_limited');
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({
      level: 'warn',
      clientType: 'mobile',
      userAgent: USER_AGENT,
      // Só o path: a query string não chega ao log.
      path: '/auth/login',
    });
    // Sem reason: é o limite por IP, não o por conta.
    expect(limited[0].reason).toBeUndefined();
    expect(JSON.stringify(limited[0])).not.toContain('origem');
    expect(limited[0].ip).toMatch(/127\.0\.0\.1|::1/);
    expect(
      logs.events().filter((e) => e.event === 'login_failed'),
    ).toHaveLength(10);
  });
});
