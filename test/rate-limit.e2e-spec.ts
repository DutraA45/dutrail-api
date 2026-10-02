import { createHash } from 'node:crypto';
import request from 'supertest';
import type { Response } from 'supertest';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';
import { captureNestLogs, type LogCapture } from './utils/log-capture.js';

/**
 * Rate limit e proxy (A-03), contra a app real:
 * - limite de falhas de login por conta (LoginAttemptsService);
 * - limites por IP próprios das rotas de autenticação;
 * - TRUST_PROXY: de quem o X-Forwarded-For é aceito.
 *
 * Os valores vêm do .env.test (LOGIN_MAX_FAILURES=5,
 * LOGIN_FAILURE_WINDOW_MINUTES=15), iguais aos padrões de produção.
 */

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const PASSWORD = 'S3nh@Forte!';
const WRONG_PASSWORD = 'S3nh@Errada!';
const USER_AGENT = 'dutrail-e2e/1.0 (rate-limit)';

/** O corpo do 429 por IP (ThrottlerGuard); o por conta tem de ser idêntico. */
const THROTTLED_BODY = {
  statusCode: 429,
  error: 'Too Many Requests',
  message: 'ThrottlerException: Too Many Requests',
};

/** O que o cliente vê de uma resposta, sem o que muda a cada request. */
function visible(res: Response) {
  const { timestamp, ...body } = res.body as Record<string, unknown>;
  expect(new Date(timestamp as string).toISOString()).toBe(timestamp);
  return { status: res.status, body };
}

function expectThrottled(res: Response, path: string): void {
  expect(res.status).toBe(429);
  expect(visible(res).body).toEqual({ ...THROTTLED_BODY, path });
  const retryAfter = Number(res.headers['retry-after']);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
}

describe('Limite de falhas de login por conta (e2e)', () => {
  let t: TestApp;
  let logs: LogCapture;

  const http = () => request(t.app.getHttpServer());
  /** Request vinda do IP `ip` (TRUST_PROXY=1: o último salto do header). */
  const loginFrom = (ip: string, email: string, password: string) =>
    http()
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .set('User-Agent', USER_AGENT)
      .set('X-Forwarded-For', ip)
      .send({ email, password });
  const login = (email: string, password: string) =>
    loginFrom('203.0.113.10', email, password);

  async function signup(email: string): Promise<void> {
    await http()
      .post('/auth/signup')
      .set('X-Client-Type', 'mobile')
      .send({ email, password: PASSWORD })
      .expect(201);
  }

  /** `times` falhas seguidas, todas 401. */
  async function fail(email: string, times = MAX_FAILURES): Promise<void> {
    for (let i = 0; i < times; i++) {
      await login(email, WRONG_PASSWORD).expect(401);
    }
  }

  beforeAll(async () => {
    // Sem o throttler por IP (o padrão dos e2e): aqui só o limite por conta
    // responde 429. TRUST_PROXY=1 deixa simular IPs pelo X-Forwarded-For.
    t = await createAppWithEnv({
      SECURITY_LOG_ENABLED: 'true',
      TRUST_PROXY: '1',
    });
    logs = await captureNestLogs();
  });

  beforeEach(async () => {
    await t.resetDb();
    logs.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    logs.restore();
    await t.close();
    vi.unstubAllEnvs();
  });

  it(`depois de ${MAX_FAILURES} falhas, a senha certa também recebe 429 (o mesmo do rate limit)`, async () => {
    await signup('ana@example.com');
    await fail('ana@example.com');

    const res = await login('ana@example.com', PASSWORD);
    expectThrottled(res, '/auth/login');
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(
      WINDOW_MS / 1000,
    );
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();

    // Continua recusando, inclusive no fluxo web.
    await login('ana@example.com', PASSWORD).expect(429);
    await http()
      .post('/auth/login')
      .set('X-Client-Type', 'web')
      .send({ email: 'ana@example.com', password: PASSWORD })
      .expect(429);
  });

  it('conta inexistente e conta só-Google têm o mesmo comportamento e a mesma resposta (não vaza existência)', async () => {
    await signup('ana@example.com');
    await t.prisma.user.create({
      data: {
        email: 'gabi@example.com',
        googleId: 'google-id-gabi',
        emailVerified: true,
      },
    });

    const transcript = async (email: string) => {
      const seen: { status: number; body: Record<string, unknown> }[] = [];
      for (let i = 0; i < MAX_FAILURES + 2; i++) {
        // A última é a senha "certa" da Ana, para todos.
        const password = i === MAX_FAILURES + 1 ? PASSWORD : WRONG_PASSWORD;
        const res = await login(email, password);
        const { body, status } = visible(res);
        // O path é o mesmo; o retry-after só varia com o relógio.
        seen.push({ status, body });
        if (status === 429) {
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(
            WINDOW_MS / 1000 - 30,
          );
        }
      }
      return seen;
    };

    const existing = await transcript('ana@example.com');
    const unknown = await transcript('ninguem@example.com');
    const googleOnly = await transcript('gabi@example.com');

    expect(existing.map((r) => r.status)).toEqual([
      ...Array<number>(MAX_FAILURES).fill(401),
      429,
      429,
    ]);
    expect(unknown).toEqual(existing);
    expect(googleOnly).toEqual(existing);
  });

  it('o bloqueio de um email não afeta outro', async () => {
    await signup('ana@example.com');
    await signup('bruno@example.com');
    await fail('ana@example.com');
    await login('ana@example.com', PASSWORD).expect(429);

    await login('bruno@example.com', PASSWORD).expect(200);
    await fail('bruno@example.com', MAX_FAILURES - 1);
    await login('bruno@example.com', PASSWORD).expect(200);
  });

  it('IPs diferentes contra o mesmo email compartilham o contador', async () => {
    await signup('ana@example.com');
    const ips = ['198.51.100.1', '198.51.100.2', '2001:db8::7'];

    for (let i = 0; i < MAX_FAILURES; i++) {
      await loginFrom(
        ips[i % ips.length],
        'ana@example.com',
        WRONG_PASSWORD,
      ).expect(401);
    }
    expectThrottled(
      await loginFrom('192.0.2.99', 'ana@example.com', PASSWORD),
      '/auth/login',
    );

    // Os IPs eram mesmo diferentes (é o que o log de segurança registrou).
    const failedIps = logs
      .events()
      .filter((e) => e.event === 'login_failed')
      .map((e) => e.ip);
    expect(new Set(failedIps)).toEqual(new Set(ips));
  });

  it('um login certo antes do limite zera o contador', async () => {
    await signup('ana@example.com');
    await fail('ana@example.com', MAX_FAILURES - 1);
    await login('ana@example.com', PASSWORD).expect(200);

    await fail('ana@example.com', MAX_FAILURES);
    await login('ana@example.com', PASSWORD).expect(429);
  });

  it('o bloqueio acaba quando a janela expira (e não é estendido pelas recusas)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    await signup('ana@example.com');
    await fail('ana@example.com');

    vi.setSystemTime(start + WINDOW_MS - 1_000);
    const res = await login('ana@example.com', PASSWORD).expect(429);
    expect(res.headers['retry-after']).toBe('1');

    vi.setSystemTime(start + WINDOW_MS);
    await login('ana@example.com', PASSWORD).expect(200);
  });

  it('o 429 vira rate_limited com reason account_login_limit e a rota, sem email nem hash', async () => {
    await signup('ana@example.com');
    await fail('ana@example.com');
    logs.clear();
    await login('ana@example.com', PASSWORD).expect(429);

    const limited = logs.events().filter((e) => e.event === 'rate_limited');
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({
      level: 'warn',
      reason: 'account_login_limit',
      path: '/auth/login',
      ip: '203.0.113.10',
      clientType: 'mobile',
      userAgent: USER_AGENT,
    });
    expect(limited[0].emailMasked).toBeUndefined();
    expect(limited[0].userId).toBeUndefined();
    // Nada de login_failed nem login_success para a tentativa recusada.
    expect(logs.events().map((e) => e.event)).toEqual(['rate_limited']);

    const key = createHash('sha256').update('ana@example.com').digest('hex');
    for (const { text } of logs.lines) {
      expect(text).not.toContain('ana@example.com');
      expect(text).not.toContain(key);
      expect(text).not.toContain(PASSWORD);
    }
  });
});

describe('Limites por rota (e2e)', () => {
  let t: TestApp;
  let accessToken: string;

  beforeAll(async () => {
    t = await createAppWithEnv({}, { keepThrottling: true });
    await t.resetDb();
    const res = await request(t.app.getHttpServer())
      .post('/auth/signup')
      .set('X-Client-Type', 'mobile')
      .send({ email: 'ana@example.com', password: PASSWORD })
      .expect(201);
    accessToken = res.body.accessToken as string;
  });

  afterAll(async () => {
    await t.close();
    vi.unstubAllEnvs();
  });

  // Em sequência, no mesmo IP: cada rota começa do zero, então os contadores
  // são separados. O signup do beforeAll gastou 1 dos 10 do signup. O login
  // usa um email por tentativa, para o limite por conta (5) não responder antes.
  it.each([
    { path: '/auth/refresh', limit: 30, status: 401, body: () => ({}) },
    { path: '/auth/logout', limit: 30, status: 204, body: () => ({}) },
    {
      path: '/auth/google/exchange',
      limit: 20,
      status: 401,
      body: () => ({ code: 'a'.repeat(43) }),
    },
    { path: '/auth/logout-all', limit: 20, status: 204, body: () => ({}) },
    {
      path: '/auth/login',
      limit: 10,
      status: 401,
      body: (i: number) => ({
        email: `x${i}@example.com`,
        password: WRONG_PASSWORD,
      }),
    },
    {
      path: '/auth/signup',
      limit: 9,
      status: 400,
      body: () => ({ email: 'invalido', password: PASSWORD }),
    },
  ])(
    '$path: $limit por minuto por IP, depois 429',
    async ({ path, limit, status, body }) => {
      const post = (i: number) =>
        request(t.app.getHttpServer())
          .post(path)
          .set('X-Client-Type', 'mobile')
          .set('Authorization', `Bearer ${accessToken}`)
          .send(body(i));

      for (let i = 0; i < limit; i++) {
        expect((await post(i)).status, `${path} #${i + 1}`).toBe(status);
      }
      expectThrottled(await post(limit), path);
    },
  );
});

describe('TRUST_PROXY (e2e)', () => {
  /** O ip que o log de segurança registrou para um login com o header dado. */
  async function ipSeenWith(
    t: TestApp,
    logs: LogCapture,
    forwardedFor: string,
  ): Promise<string | undefined> {
    logs.clear();
    await request(t.app.getHttpServer())
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .set('X-Forwarded-For', forwardedFor)
      .send({ email: 'ninguem@example.com', password: WRONG_PASSWORD })
      .expect(401);
    const [line] = logs.events().filter((e) => e.event === 'login_failed');
    return line?.ip;
  }

  /** 10 logins (o limite da rota) e mais um, cada um com o header dado. */
  async function exhaustLogin(t: TestApp, headers: (i: number) => string) {
    const statuses: number[] = [];
    for (let i = 0; i <= 10; i++) {
      const res = await request(t.app.getHttpServer())
        .post('/auth/login')
        .set('X-Client-Type', 'mobile')
        .set('X-Forwarded-For', headers(i))
        .send({ email: `x${i}@example.com`, password: WRONG_PASSWORD });
      statuses.push(res.status);
    }
    return statuses;
  }

  describe('sem a variável (padrão)', () => {
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

    it('o X-Forwarded-For é ignorado: req.ip é o do socket', async () => {
      expect(t.app.getHttpAdapter().getInstance().get('trust proxy')).toBe(
        false,
      );
      const ip = await ipSeenWith(t, logs, '203.0.113.7');
      expect(ip).toMatch(/127\.0\.0\.1|::1/);
      expect(ip).not.toContain('203.0.113.7');
    });

    it('trocar o X-Forwarded-For não escapa do rate limit por IP', async () => {
      // 1 login já gasto no teste anterior.
      const statuses = await exhaustLogin(t, (i) => `198.51.100.${i + 1}`);
      expect(statuses.slice(0, 9)).toEqual(Array<number>(9).fill(401));
      expect(statuses.slice(9)).toEqual([429, 429]);
    });
  });

  describe('TRUST_PROXY=1 (um proxy na frente)', () => {
    let t: TestApp;
    let logs: LogCapture;

    beforeAll(async () => {
      t = await createAppWithEnv(
        { SECURITY_LOG_ENABLED: 'true', TRUST_PROXY: '1' },
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

    it('chega ao Express como número de saltos', () => {
      expect(t.app.getHttpAdapter().getInstance().get('trust proxy')).toBe(1);
    });

    it('req.ip é o último salto do header; entradas forjadas à esquerda não mudam o IP', async () => {
      expect(await ipSeenWith(t, logs, '203.0.113.7')).toBe('203.0.113.7');
      expect(await ipSeenWith(t, logs, '6.6.6.6, 10.0.0.1, 203.0.113.7')).toBe(
        '203.0.113.7',
      );
      expect(await ipSeenWith(t, logs, '203.0.113.7, 198.51.100.4')).toBe(
        '198.51.100.4',
      );
    });

    it('o rate limit usa esse IP: forjar a esquerda não escapa, outro cliente não é afetado', async () => {
      // 2 dos 10 de 203.0.113.7 já foram gastos no teste anterior.
      const statuses = await exhaustLogin(
        t,
        (i) => `10.9.8.${i}, 172.16.0.${i}, 203.0.113.7`,
      );
      expect(statuses.slice(0, 8)).toEqual(Array<number>(8).fill(401));
      expect(statuses.slice(8)).toEqual([429, 429, 429]);

      // Outro cliente atrás do mesmo proxy tem o seu próprio contador.
      const other = await exhaustLogin(t, () => '192.0.2.50');
      expect(other.slice(0, 10)).toEqual(Array<number>(10).fill(401));
      expect(other[10]).toBe(429);
    });
  });

  it.each(['true', '*', 'TRUE', '0.0.0.0/0', '::/0', '10.0.0.1, *'])(
    'TRUST_PROXY=%s é recusado no boot, dizendo a variável e o motivo',
    async (value) => {
      try {
        await expect(createAppWithEnv({ TRUST_PROXY: value })).rejects.toThrow(
          /TRUST_PROXY .*forjável/,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
