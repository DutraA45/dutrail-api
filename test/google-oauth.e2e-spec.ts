import { createHash } from 'node:crypto';
import request from 'supertest';
import type * as FakeGoogleModule from './fakes/fake-google.strategy.js';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';
import { captureNestLogs, type LogCapture } from './utils/log-capture.js';

/**
 * Login com Google ponta a ponta (A-02 e A-13), com a GoogleStrategy real e só
 * a rede do Google simulada (test/fakes/fake-google.strategy.ts):
 * - o state e o code_verifier ficam num cookie assinado e de uso único;
 * - toda falha do callback vira 302 para o frontend com ?error=<código fixo>;
 * - nada disso (state, verifier, cookie, code) chega a log algum.
 *
 * A app sobe com o log de segurança ligado; o fake e o Logger são importados
 * depois dela (ver createAppWithEnv).
 */

const FRONTEND = 'http://localhost:4200';
const CALLBACK_URL = 'http://localhost:3000/auth/google/callback';
const USER_AGENT = 'dutrail-e2e/1.0 (google-oauth)';
const STATE_COOKIE = 'googleOAuthState';

const errorLocation = (code: string) =>
  `${FRONTEND}/auth/callback?error=${code}`;

type Res = Awaited<ReturnType<ReturnType<typeof request>['get']>>;

function setCookies(res: Res): string[] {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header ?? [];
}

/** Payload do cookie selado (assinado, não cifrado: o teste consegue ler). */
function cookiePayload(sealed: string): { s: string; v: string; exp: number } {
  return JSON.parse(
    Buffer.from(sealed.split('.')[0], 'base64url').toString('utf8'),
  ) as { s: string; v: string; exp: number };
}

/** O cookie de state foi apagado com as mesmas opções do set, e só isso. */
function expectStateCookieCleared(res: Res, secure = false): void {
  const cookies = setCookies(res).filter((c) =>
    c.startsWith(`${STATE_COOKIE}=`),
  );
  expect(cookies).toHaveLength(1);
  const [cleared] = cookies;
  expect(cleared).toMatch(new RegExp(`^${STATE_COOKIE}=;`));
  expect(cleared).toContain('Path=/auth/google');
  expect(cleared).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  expect(cleared).toContain('HttpOnly');
  expect(cleared).toMatch(/SameSite=Lax/);
  if (secure) expect(cleared).toMatch(/; Secure/);
  else expect(cleared).not.toMatch(/; Secure/);
}

describe('Login com Google: state + PKCE (A-02) e erros no frontend (A-13) (e2e)', () => {
  let t: TestApp;
  let logs: LogCapture;
  let google: typeof FakeGoogleModule;
  /** Valores sensíveis vistos no teste corrente; o afterEach varre os logs. */
  let secrets: string[];

  const server = () => t.app.getHttpServer();
  const browser = () => request.agent(server());
  const get = (agent: ReturnType<typeof browser>, path: string) =>
    agent.get(path).set('User-Agent', USER_AGENT);

  /** Passo 1 + consentimento, registrando state, cookie e code como segredos. */
  async function start(agent: ReturnType<typeof browser>) {
    const consent = await google.startGoogleLogin(agent, USER_AGENT);
    const { v: verifier } = cookiePayload(consent.stateCookie);
    secrets.push(consent.state, consent.stateCookie, consent.code, verifier);
    return { ...consent, verifier };
  }

  function failureReasons(): (string | undefined)[] {
    return logs
      .events()
      .filter((e) => e.event === 'google_exchange_failed')
      .map((e) => e.reason);
  }

  beforeAll(async () => {
    t = await createAppWithEnv({ SECURITY_LOG_ENABLED: 'true' });
    google = await import('./fakes/fake-google.strategy.js');
    logs = await captureNestLogs();
  });

  beforeEach(async () => {
    await t.resetDb();
    google.fakeGoogle.reset();
    logs.clear();
    secrets = [];
  });

  afterEach(() => {
    // Varredura: nenhum log (de nenhum logger) carrega state, verifier, o
    // cookie selado ou o code do Google, e nenhum desfecho gerou stack.
    secrets.push(
      ...google.fakeGoogle.tokenRequests.flatMap((r) =>
        [r.code, r.codeVerifier].filter((v): v is string => !!v),
      ),
    );
    for (const { text } of logs.lines) {
      for (const secret of secrets) {
        expect(text, 'valor sensível no log').not.toContain(secret);
      }
      expect(text).not.toMatch(/\?[\w-]+=/);
    }
  });

  afterAll(async () => {
    logs.restore();
    await t.close();
    vi.unstubAllEnvs();
  });

  it('GET /auth/google: 302 com state e code_challenge S256; o verifier só no cookie', async () => {
    const agent = browser();
    const { location, state, setCookie, stateCookie, verifier } =
      await start(agent);

    const url = new URL(location);
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      redirect_uri: CALLBACK_URL,
      code_challenge_method: 'S256',
      state,
    });
    // state >= 128 bits; verifier na faixa da RFC 7636.
    expect(Buffer.from(state, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
    expect(url.searchParams.has('code_verifier')).toBe(false);
    expect(location).not.toContain(verifier);
    expect(location).not.toContain(stateCookie);

    // Cookie curto, HttpOnly, Lax, só para /auth/google; sem Secure porque o
    // .env.test tem COOKIE_SECURE=false (o caso true está no describe abaixo).
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toContain('Path=/auth/google;');
    expect(setCookie).toContain('Max-Age=600');
    expect(setCookie).not.toMatch(/; Secure/);
    expect(cookiePayload(stateCookie).exp - Date.now()).toBeLessThanOrEqual(
      600_000,
    );
  });

  it('fluxo feliz: troca o code com o verifier do cookie, apaga o cookie e o callback não pode ser repetido', async () => {
    google.fakeGoogle.profile = google.makeGoogleProfile({});
    const agent = browser();
    const consent = await start(agent);

    const res = await get(agent, google.callbackPath(consent)).expect(302);
    const code = google.exchangeCodeOf(res.headers.location);
    expect(res.headers.location).toBe(
      `${FRONTEND}/auth/callback?code=${encodeURIComponent(code)}`,
    );
    expectStateCookieCleared(res);
    expect(google.fakeGoogle.tokenRequests).toEqual([
      { code: consent.code, codeVerifier: consent.verifier },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(consent.verifier);

    // O payload de sucesso do exchange não mudou.
    const exchanged = await request(server())
      .post('/auth/google/exchange')
      .set('X-Client-Type', 'mobile')
      .send({ code })
      .expect(200);
    expect(exchanged.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: { email: 'google@example.com', hasPassword: false },
    });

    // O browser apagou o cookie: repetir o mesmo callback é state_mismatch.
    const replay = await get(agent, google.callbackPath(consent)).expect(302);
    expect(replay.headers.location).toBe(errorLocation('state_mismatch'));
    expect(google.fakeGoogle.tokenRequests).toHaveLength(1);
  });

  it('login CSRF: callback sem o cookie de state vira state_mismatch, sem trocar o code', async () => {
    google.fakeGoogle.profile = google.makeGoogleProfile({});
    // O atacante inicia o fluxo e para antes do callback...
    const consent = await start(browser());
    // ...e faz a vítima (browser sem o cookie) abrir a URL do callback.
    const res = await get(browser(), google.callbackPath(consent)).expect(302);

    expect(res.headers.location).toBe(errorLocation('state_mismatch'));
    expectStateCookieCleared(res);
    expect(google.fakeGoogle.tokenRequests).toEqual([]);
    expect(await t.prisma.user.count()).toBe(0);
    expect(failureReasons()).toEqual(['state_mismatch']);
  });

  it('state divergente (adulterado ou de outro fluxo) vira state_mismatch', async () => {
    google.fakeGoogle.profile = google.makeGoogleProfile({});
    const agent = browser();
    const consent = await start(agent);
    const flipped = `${consent.state.slice(0, -1)}${consent.state.endsWith('A') ? 'B' : 'A'}`;

    for (const state of [flipped, '', `${consent.state}x`]) {
      const res = await get(
        agent,
        google.callbackPath({ code: consent.code, state }),
      ).expect(302);
      expect(res.headers.location).toBe(errorLocation('state_mismatch'));
      expectStateCookieCleared(res);
    }
    expect(google.fakeGoogle.tokenRequests).toEqual([]);
  });

  it('cookie adulterado vira state_mismatch, mesmo com o state certo', async () => {
    google.fakeGoogle.profile = google.makeGoogleProfile({});
    const consent = await start(browser());
    const [payload, mac] = consent.stateCookie.split('.');
    const other = Buffer.from(
      JSON.stringify({
        ...cookiePayload(consent.stateCookie),
        v: 'w'.repeat(43),
      }),
    ).toString('base64url');

    for (const tampered of [
      `${other}.${mac}`,
      `${payload}.${mac.slice(0, -2)}xx`,
      payload,
      'lixo',
    ]) {
      const res = await request(server())
        .get(google.callbackPath(consent))
        .set('Cookie', `${STATE_COOKIE}=${encodeURIComponent(tampered)}`)
        .expect(302);
      expect(res.headers.location).toBe(errorLocation('state_mismatch'));
      expectStateCookieCleared(res);
    }
    expect(google.fakeGoogle.tokenRequests).toEqual([]);
  });

  it('cookie expirado (prazo assinado de 10 minutos) vira state_mismatch', async () => {
    google.fakeGoogle.profile = google.makeGoogleProfile({});
    const consent = await start(browser());

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000);
      // Reapresentado à mão: o browser já o teria descartado pelo Max-Age.
      const res = await request(server())
        .get(google.callbackPath(consent))
        .set(
          'Cookie',
          `${STATE_COOKIE}=${encodeURIComponent(consent.stateCookie)}`,
        )
        .expect(302);
      expect(res.headers.location).toBe(errorLocation('state_mismatch'));
      expectStateCookieCleared(res);
    } finally {
      vi.useRealTimers();
    }
    expect(google.fakeGoogle.tokenRequests).toEqual([]);
  });

  it('cancelamento no Google vira access_denied, sem repassar a descrição', async () => {
    const agent = browser();
    const consent = await start(agent);

    const res = await get(
      agent,
      google.callbackPath({
        error: 'access_denied',
        error_description: 'The user denied access',
        state: consent.state,
      }),
    ).expect(302);

    expect(res.headers.location).toBe(errorLocation('access_denied'));
    expectStateCookieCleared(res);
    expect(failureReasons()).toEqual(['access_denied']);
    expect(JSON.stringify(logs.lines)).not.toContain('denied access');
  });

  it('outro error= do Google vira oauth_failed', async () => {
    const agent = browser();
    const consent = await start(agent);

    const res = await get(
      agent,
      google.callbackPath({
        error: 'invalid_scope',
        error_description: '<script>alert(1)</script>',
        state: consent.state,
      }),
    ).expect(302);

    expect(res.headers.location).toBe(errorLocation('oauth_failed'));
    expectStateCookieCleared(res);
    expect(failureReasons()).toEqual(['callback_error']);
    expect(logs.lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('email não verificado vira email_not_verified e não vincula a conta', async () => {
    await request(server())
      .post('/auth/signup')
      .set('X-Client-Type', 'mobile')
      .send({ email: 'ana@example.com', password: 'S3nh@Forte!' })
      .expect(201);
    google.fakeGoogle.profile = google.makeGoogleProfile({
      email: 'ana@example.com',
      verified: false,
    });
    const agent = browser();
    const consent = await start(agent);

    const res = await get(agent, google.callbackPath(consent)).expect(302);

    expect(res.headers.location).toBe(errorLocation('email_not_verified'));
    expectStateCookieCleared(res);
    const stored = await t.prisma.user.findUniqueOrThrow({
      where: { email: 'ana@example.com' },
    });
    expect(stored.googleId).toBeNull();
    expect(failureReasons()).toEqual(['email_not_verified']);
    expect(logs.lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('code inválido vira oauth_failed, sem 500 e sem stack no log', async () => {
    google.fakeGoogle.profile = google.makeGoogleProfile({});
    const agent = browser();
    const consent = await start(agent);

    const res = await get(
      agent,
      google.callbackPath({ code: 'c0de-lixo', state: consent.state }),
    ).expect(302);

    expect(res.headers.location).toBe(errorLocation('oauth_failed'));
    expectStateCookieCleared(res);
    // O state passou; a troca foi tentada (com o verifier) e o Google recusou.
    expect(google.fakeGoogle.tokenRequests).toEqual([
      { code: 'c0de-lixo', codeVerifier: consent.verifier },
    ]);
    expect(failureReasons()).toEqual(['callback_error']);
    expect(logs.lines.filter((l) => l.level === 'error')).toEqual([]);
    expect(JSON.stringify(logs.lines)).not.toContain('Malformed auth code');
  });

  it('injeção de code (PKCE): code emitido para outro fluxo não troca com o verifier deste browser', async () => {
    google.fakeGoogle.profile = google.makeGoogleProfile({});
    // Code do fluxo do atacante (amarrado ao code_challenge dele).
    const attacker = await start(browser());
    // A vítima tem o próprio cookie e state válidos.
    const victim = browser();
    const own = await start(victim);

    const res = await get(
      victim,
      google.callbackPath({ code: attacker.code, state: own.state }),
    ).expect(302);

    expect(res.headers.location).toBe(errorLocation('oauth_failed'));
    expectStateCookieCleared(res);
    expect(google.fakeGoogle.tokenRequests).toEqual([
      { code: attacker.code, codeVerifier: own.verifier },
    ]);
    expect(await t.prisma.user.count()).toBe(0);
  });

  it('callback sem code nem error vira oauth_failed, sem iniciar outro fluxo', async () => {
    const res = await get(browser(), '/auth/google/callback').expect(302);

    expect(res.headers.location).toBe(errorLocation('oauth_failed'));
    // Só o clear: nenhum cookie de state novo.
    expect(setCookies(res)).toHaveLength(1);
    expectStateCookieCleared(res);
  });

  it('dois inícios no mesmo browser: vale o último (o callback do primeiro vira state_mismatch)', async () => {
    google.fakeGoogle.profile = google.makeGoogleProfile({});
    const agent = browser();
    const first = await start(agent);
    const second = await start(agent);

    const stale = await get(agent, google.callbackPath(first)).expect(302);
    expect(stale.headers.location).toBe(errorLocation('state_mismatch'));
    // O stale apagou o cookie: o segundo também não conclui mais.
    const after = await get(agent, google.callbackPath(second)).expect(302);
    expect(after.headers.location).toBe(errorLocation('state_mismatch'));
  });
});

describe('Login com Google com COOKIE_SECURE=true (e2e)', () => {
  let t: TestApp;
  let google: typeof FakeGoogleModule;

  beforeAll(async () => {
    t = await createAppWithEnv({ COOKIE_SECURE: 'true' });
    google = await import('./fakes/fake-google.strategy.js');
  });

  beforeEach(async () => {
    await t.resetDb();
    google.fakeGoogle.reset();
  });

  afterAll(async () => {
    await t.close();
    vi.unstubAllEnvs();
  });

  it('o cookie de state sai com Secure, e o clear também', async () => {
    google.fakeGoogle.profile = google.makeGoogleProfile({});
    const consent = await google.startGoogleLogin(
      request.agent(t.app.getHttpServer()),
    );
    expect(consent.setCookie).toMatch(/; Secure/);
    expect(consent.setCookie).toContain('HttpOnly');
    expect(consent.setCookie).toMatch(/SameSite=Lax/);
    expect(consent.setCookie).toContain('Path=/auth/google;');

    // O cookie jar do supertest não reenvia Secure em http://: vai à mão,
    // como o browser faria em HTTPS.
    const res = await request(t.app.getHttpServer())
      .get(google.callbackPath(consent))
      .set(
        'Cookie',
        `${STATE_COOKIE}=${encodeURIComponent(consent.stateCookie)}`,
      )
      .expect(302);
    google.exchangeCodeOf(res.headers.location);
    expectStateCookieCleared(res, true);
  });
});
