import { createHash } from 'node:crypto';
import request from 'supertest';
import type * as FakeBreachedModule from './fakes/fake-breached-password.service.js';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';
import { captureNestLogs, type LogCapture } from './utils/log-capture.js';

/**
 * Senha vazada no cadastro (A-09). A app sobe com o log de segurança ligado
 * para conferir os eventos; como o createAppWithEnv reimporta os módulos, o
 * `fakeBreachedPasswords` e o Logger são importados depois de a app subir.
 */

const email = 'ana@example.com';
const BREACHED = 'password123';
const BREACHED_MESSAGE =
  'password has appeared in a known data breach; choose a different one';
// "é" pré-composto (U+00E9) e "e" + acento agudo combinante (U+0301).
const COMPOSED = 'café-S3nh@';
const DECOMPOSED = 'café-S3nh@';

describe('Senha vazada no cadastro (A-09, e2e)', () => {
  let t: TestApp;
  let logs: LogCapture;
  let fake: typeof FakeBreachedModule.fakeBreachedPasswords;

  const post = (path: string, body: object) =>
    request(t.app.getHttpServer())
      .post(path)
      .set('X-Client-Type', 'mobile')
      .send(body);

  beforeAll(async () => {
    t = await createAppWithEnv({ SECURITY_LOG_ENABLED: 'true' });
    ({ fakeBreachedPasswords: fake } =
      await import('./fakes/fake-breached-password.service.js'));
    logs = await captureNestLogs();
  });

  beforeEach(async () => {
    await t.resetDb();
    logs.clear();
  });

  afterAll(async () => {
    logs.restore();
    await t.close();
    vi.unstubAllEnvs();
  });

  it('recusa com 400 a senha vazada, sem criar usuário, e registra o motivo', async () => {
    fake.breached.add(BREACHED);

    const res = await post('/auth/signup', {
      email,
      password: BREACHED,
    }).expect(400);

    expect(res.body).toMatchObject({
      statusCode: 400,
      message: [BREACHED_MESSAGE],
      path: '/auth/signup',
    });
    expect(await t.prisma.user.count()).toBe(0);
    expect(logs.events()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        event: 'signup_rejected',
        reason: 'breached_password',
        emailMasked: 'a***@e***.com',
      }),
    );
    // Nada do log carrega a senha.
    for (const { text } of logs.lines) expect(text).not.toContain(BREACHED);
  });

  it('a forma decomposta de uma senha vazada também é recusada (NFKC)', async () => {
    fake.breached.add(COMPOSED);
    await post('/auth/signup', { email, password: DECOMPOSED }).expect(400);
  });

  it('senha fora da lista: cadastro normal', async () => {
    fake.breached.add(BREACHED);
    await post('/auth/signup', { email, password: 'S3nh@Forte!' }).expect(201);
    expect(fake.checked).toEqual(['S3nh@Forte!']);
  });

  it.each([
    ['timeout', 'timeout'],
    ['error', 'check_error'],
  ] as const)(
    'API indisponível (%s): o cadastro segue e sai um warn',
    async (outcome, reason) => {
      fake.outcome = outcome;

      await post('/auth/signup', { email, password: BREACHED }).expect(201);

      expect(logs.events()).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          event: 'breach_check_unavailable',
          reason,
        }),
      );
    },
  );

  it('email já cadastrado: 409 sem consultar a lista', async () => {
    await post('/auth/signup', { email, password: 'S3nh@Forte!' }).expect(201);
    fake.checked = [];
    fake.breached.add(BREACHED);

    await post('/auth/signup', { email, password: BREACHED }).expect(409);
    expect(fake.checked).toEqual([]);
  });

  it('login não consulta a lista: senha que vazou depois do cadastro continua entrando', async () => {
    await post('/auth/signup', { email, password: 'S3nh@Forte!' }).expect(201);
    fake.checked = [];
    fake.breached.add('S3nh@Forte!');

    await post('/auth/login', { email, password: 'S3nh@Forte!' }).expect(200);
    expect(fake.checked).toEqual([]);
  });
});

describe('Senha vazada: service real ligado pelo env (A-09, e2e)', () => {
  let t: TestApp | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Nenhum teste vai à rede: a range API é simulada no `fetch` global.
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await t?.close();
    t = undefined;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const signup = (password: string) =>
    request(t!.app.getHttpServer())
      .post('/auth/signup')
      .set('X-Client-Type', 'mobile')
      .send({ email, password });

  it('BREACHED_PASSWORD_CHECK=true: consulta a range API só com o prefixo e recusa a vazada', async () => {
    const sha1 = createHash('sha1')
      .update(BREACHED)
      .digest('hex')
      .toUpperCase();
    fetchMock.mockResolvedValue(new Response(`${sha1.slice(5)}:12345\r\n`));
    t = await createAppWithEnv(
      { BREACHED_PASSWORD_CHECK: 'true' },
      { realBreachedPasswordCheck: true },
    );
    await t.resetDb();

    const res = await signup(BREACHED).expect(400);

    expect(res.body.message).toEqual([BREACHED_MESSAGE]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`,
    );
  });

  it('BREACHED_PASSWORD_CHECK=false (o .env.test): não vai à rede', async () => {
    t = await createAppWithEnv({}, { realBreachedPasswordCheck: true });
    await t.resetDb();

    await signup(BREACHED).expect(201);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
