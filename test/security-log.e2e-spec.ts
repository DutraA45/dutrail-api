import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type * as FakeGoogleModule from './fakes/fake-google.strategy.js';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';

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

interface CapturedLine {
  level: string;
  /** Mensagem + parâmetros extras (stack, contexto), serializados. */
  text: string;
  message: unknown;
}

interface SecurityLine {
  level: string;
  event: string;
  timestamp: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  clientType?: string;
  emailMasked?: string;
  reason?: string;
}

const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

async function captureNestLogs() {
  const { Logger } = await import('@nestjs/common');
  const lines: CapturedLine[] = [];
  const spies = LEVELS.map((level) =>
    vi
      .spyOn(Logger.prototype, level)
      .mockImplementation((message: unknown, ...rest: unknown[]) => {
        lines.push({
          level,
          message,
          text: JSON.stringify([message, ...rest]),
        });
      }),
  );

  return {
    lines,
    clear: () => {
      lines.length = 0;
    },
    restore: () => spies.forEach((spy) => spy.mockRestore()),
    /** Só as linhas do SecurityLog, parseadas. */
    events: (): SecurityLine[] =>
      lines.flatMap(({ level, message }) => {
        if (typeof message !== 'string' || !message.startsWith('{')) return [];
        const parsed = JSON.parse(message) as Partial<SecurityLine>;
        return parsed.event ? [{ level, ...parsed } as SecurityLine] : [];
      }),
  };
}

type LogCapture = Awaited<ReturnType<typeof captureNestLogs>>;

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

  const http = () => request(t.app.getHttpServer());
  const post = (path: string, clientType: 'web' | 'mobile' = 'mobile') =>
    http()
      .post(path)
      .set('X-Client-Type', clientType)
      .set('User-Agent', USER_AGENT);
  const callback = (query: string) =>
    http().get(`/auth/google/callback?${query}`).set('User-Agent', USER_AGENT);

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
    const res = await callback('code=google-c0de&state=st4te').expect(302);
    return new URL(res.headers.location).searchParams.get('code')!;
  }

  beforeAll(async () => {
    t = await createAppWithEnv({ SECURITY_LOG_ENABLED: 'true' });
    ({ fakeGoogle, makeGoogleProfile } =
      await import('./fakes/fake-google.strategy.js'));
    logs = await captureNestLogs();
  });

  beforeEach(async () => {
    await t.resetDb();
    fakeGoogle.profile = null;
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

  it('refresh, reuso do token rotacionado (com userId) e falhas de refresh', async () => {
    const { userId, refreshToken } = await signup();
    logs.clear();

    await post('/auth/refresh').send({ refreshToken }).expect(200);
    expectEvent(logs, { event: 'refresh_success', level: 'log', userId });

    await post('/auth/refresh').send({ refreshToken }).expect(401);
    expectEvent(logs, {
      event: 'refresh_reuse_detected',
      level: 'warn',
      userId,
    });

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

  it('falha do callback do Google (500 e 401): callback_error, sem a query', async () => {
    // Sem perfil configurado, a strategy falsa falha com um Error comum: 500.
    await callback('code=abc123&state=st4te987').expect(500);
    // Email não verificado pelo Google: 401.
    fakeGoogle.profile = makeGoogleProfile({ verified: false });
    await callback('code=def456&state=st4te654').expect(401);

    const failures = logs
      .events()
      .filter((e) => e.event === 'google_exchange_failed');
    expect(failures).toHaveLength(2);
    for (const line of failures) {
      expect(line).toMatchObject({
        level: 'warn',
        reason: 'callback_error',
        userAgent: USER_AGENT,
      });
    }
    const all = logs.lines.map((l) => l.text).join('\n');
    for (const value of ['abc123', 'st4te987', 'def456', 'st4te654', '?code']) {
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

    // Refresh, reuso e logout.
    const mobileRt = signupRes.body.refreshToken as string;
    const rotated = await post('/auth/refresh')
      .send({ refreshToken: mobileRt })
      .expect(200);
    secrets.push(rotated.body.accessToken, rotated.body.refreshToken);
    await post('/auth/refresh').send({ refreshToken: mobileRt }).expect(401);
    // A sessão web caiu junto com o reuso: o cookie dela também é reuso.
    await webPost('/auth/refresh').expect(401);
    await post('/auth/logout')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(204);
    // Token apagado no logout: "não encontrado", sem acionar o reuso.
    await post('/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);
    expectEvent(logs, { event: 'refresh_invalid', reason: 'not_found' });

    // Google: callback com falha, callback ok (takeover), troca válida e inválida.
    await callback('code=g00gle-auth-c0de&state=0auth-st4te').expect(500);
    fakeGoogle.profile = makeGoogleProfile({
      email: credentials.email,
      id: 'google-id-ana',
    });
    const cb = await callback('code=g00gle-auth-c0de&state=0auth-st4te').expect(
      302,
    );
    const exchangeCode = new URL(cb.headers.location).searchParams.get('code')!;
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

    // O fluxo emitiu de fato os eventos esperados...
    const emitted = new Set(logs.events().map((e) => e.event));
    for (const event of [
      'signup',
      'login_failed',
      'login_success',
      'refresh_success',
      'refresh_reuse_detected',
      'refresh_invalid',
      'logout',
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

  it('o 429 do throttler vira rate_limited', async () => {
    const login = () =>
      request(t.app.getHttpServer())
        .post('/auth/login')
        .set('X-Client-Type', 'mobile')
        .set('User-Agent', USER_AGENT)
        .send({ email: 'x@example.com', password: 'qualquer1' });

    for (let i = 0; i < 10; i++) {
      await login().expect(401);
    }
    const res = await login().expect(429);
    // A resposta ao cliente é a mesma de antes.
    expect(res.body).toMatchObject({ statusCode: 429, path: '/auth/login' });

    const limited = logs.events().filter((e) => e.event === 'rate_limited');
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({
      level: 'warn',
      clientType: 'mobile',
      userAgent: USER_AGENT,
    });
    expect(limited[0].ip).toMatch(/127\.0\.0\.1|::1/);
    expect(
      logs.events().filter((e) => e.event === 'login_failed'),
    ).toHaveLength(10);
  });
});
