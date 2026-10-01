import request from 'supertest';
import type { ClientType } from '../src/common/decorators/client-type.decorator.js';
import { TokenService } from '../src/auth/token.service.js';
import {
  CLIENT_TYPES,
  createClient,
  setCookieRaw,
  type TestClient,
} from './utils/client.js';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';
import { captureNestLogs, type LogCapture } from './utils/log-capture.js';

/**
 * POST /auth/logout-all (A-08): apaga todas as sessões (famílias de refresh
 * token) e os códigos de troca pendentes do usuário, contra o Postgres real.
 *
 * A app sobe com o log de segurança ligado para conferir o `logout_all` e que
 * um token reapresentado depois dele cai no "não encontrado", e não na janela
 * de tolerância nem na detecção de reuso.
 */

const PASSWORD = 'S3nh@Forte!';
const ana = { email: 'ana@example.com', password: PASSWORD, name: 'Ana' };
const bob = { email: 'bob@example.com', password: PASSWORD, name: 'Bob' };

interface Session {
  client: TestClient;
  accessToken: string;
  refreshToken: string;
}

describe('POST /auth/logout-all (e2e)', () => {
  let t: TestApp;
  let logs: LogCapture;

  const http = () => request(t.app.getHttpServer());

  /** Signup num cliente novo; a primeira sessão (família) do usuário. */
  async function signup(
    type: ClientType,
    user: typeof ana,
  ): Promise<Session & { userId: string }> {
    const client = createClient(t.app, type);
    const res = await client.post('/auth/signup').send(user).expect(201);
    return {
      client,
      userId: res.body.user.id as string,
      accessToken: res.body.accessToken as string,
      refreshToken: client.refreshTokenOf(res)!,
    };
  }

  /** Login num "outro dispositivo": outra família do mesmo usuário. */
  async function login(type: ClientType, user: typeof ana): Promise<Session> {
    const client = createClient(t.app, type);
    const res = await client
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    return {
      client,
      accessToken: res.body.accessToken as string,
      refreshToken: client.refreshTokenOf(res)!,
    };
  }

  /** logout-all pelo cliente da sessão (web leva o cookie do jar junto). */
  const logoutAll = (session: Session) =>
    session.client
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${session.accessToken}`);

  /** Refresh com um token específico, num cliente sem estado do tipo dado. */
  const refreshWith = (type: ClientType, token: string) =>
    createClient(t.app, type).refreshWith(token);

  const rowsOf = (userId: string) =>
    t.prisma.refreshToken.count({ where: { userId } });
  const codesOf = (userId: string) =>
    t.prisma.oAuthExchangeCode.count({ where: { userId } });

  /** Código de troca do Google pendente (só o hash importa aqui). */
  const pendingCode = (userId: string, label: string) =>
    t.prisma.oAuthExchangeCode.create({
      data: {
        codeHash: TokenService.hashToken(`${label}-${userId}`),
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

  beforeAll(async () => {
    t = await createAppWithEnv({ SECURITY_LOG_ENABLED: 'true' });
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

  it('invalida todas as famílias do usuário (web e mobile), apaga os códigos pendentes e não toca em outro usuário', async () => {
    // Ana: 4 sessões (2 web, 2 mobile); uma delas já rotacionou, então são
    // 5 linhas em 4 famílias.
    const anaMobile = await signup('mobile', ana);
    const anaWebA = await login('web', ana);
    const anaWebB = await login('web', ana);
    const anaMobileB = await login('mobile', ana);
    const rotated = await anaMobileB.client
      .refresh(anaMobileB.refreshToken)
      .expect(200);
    const anaMobileB2 = rotated.body.refreshToken as string;
    await pendingCode(anaMobile.userId, 'ana');
    expect(await rowsOf(anaMobile.userId)).toBe(5);

    // Bob: 2 sessões e um código pendente.
    const bobWeb = await signup('web', bob);
    const bobMobile = await login('mobile', bob);
    await pendingCode(bobWeb.userId, 'bob');
    logs.clear();

    await logoutAll(anaWebA).expect(204);

    // Nenhuma linha da Ana sobrou; as do Bob estão intactas.
    expect(await rowsOf(anaMobile.userId)).toBe(0);
    expect(await codesOf(anaMobile.userId)).toBe(0);
    expect(await rowsOf(bobWeb.userId)).toBe(2);
    expect(await codesOf(bobWeb.userId)).toBe(1);

    // Todos os refresh tokens da Ana, de todos os dispositivos: 401.
    for (const [type, token] of [
      ['mobile', anaMobile.refreshToken],
      ['web', anaWebA.refreshToken],
      ['web', anaWebB.refreshToken],
      ['mobile', anaMobileB.refreshToken],
      ['mobile', anaMobileB2],
    ] as const) {
      const res = await refreshWith(type, token).expect(401);
      expect(res.body.message).toBe('Invalid refresh token');
    }

    // Bob continua renovando nos dois dispositivos.
    await refreshWith('web', bobWeb.refreshToken).expect(200);
    await refreshWith('mobile', bobMobile.refreshToken).expect(200);

    const lines = logs.events().filter((e) => e.event === 'logout_all');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'log',
      userId: anaMobile.userId,
      sessionsRemoved: 4,
      clientType: 'web',
    });
    // Só os campos de contexto, o userId e a contagem.
    expect(
      Object.keys(lines[0]).filter(
        (k) =>
          ![
            'level',
            'event',
            'timestamp',
            'userId',
            'sessionsRemoved',
            'ip',
            'userAgent',
            'clientType',
          ].includes(k),
      ),
    ).toEqual([]);
  });

  it('o access token atual (e o de outro dispositivo) continua válido até expirar', async () => {
    const mobile = await signup('mobile', ana);
    const web = await login('web', ana);

    await logoutAll(mobile).expect(204);

    for (const accessToken of [mobile.accessToken, web.accessToken]) {
      await http()
        .get('/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    }
  });

  it('web: a resposta limpa o cookie do dispositivo, com as mesmas opções do set', async () => {
    const web = await signup('web', ana);

    const res = await logoutAll(web).expect(204);

    const cleared = setCookieRaw(res)!;
    expect(cleared).toMatch(/^refreshToken=;/);
    expect(cleared).toContain('Path=/auth');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toMatch(/SameSite=Lax/i);
    expect(cleared).not.toMatch(/;\s*Secure/i); // igual ao set (COOKIE_SECURE=false)
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');

    // O jar do browser ficou sem o cookie: o refresh seguinte é "ausente".
    const after = await web.client.refresh().expect(401);
    expect(after.body.message).toBe('Missing refresh token');
  });

  it('mobile: 204 sem Set-Cookie', async () => {
    const mobile = await signup('mobile', ana);

    const res = await logoutAll(mobile).expect(204);

    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.text).toBe('');
  });

  it('sem Bearer (ou com o refresh token no lugar dele) é 401 e nada é apagado', async () => {
    const web = await signup('web', ana);
    const mobile = await login('mobile', ana);

    const noBearer = await web.client.post('/auth/logout-all').expect(401);
    expect(noBearer.body.message).toBe('Unauthorized');
    await http()
      .post('/auth/logout-all')
      .set('X-Client-Type', 'mobile')
      .set('Authorization', `Bearer ${mobile.refreshToken}`)
      .expect(401);

    expect(await rowsOf(web.userId)).toBe(2);
    expect(logs.events().filter((e) => e.event === 'logout_all')).toEqual([]);
  });

  it('sem X-Client-Type é 400 e nada é apagado', async () => {
    const mobile = await signup('mobile', ana);

    const res = await http()
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${mobile.accessToken}`)
      .expect(400);

    expect(res.body.message).toMatch(/x-client-type header is required/);
    expect(await rowsOf(mobile.userId)).toBe(1);
  });

  it('é idempotente: a segunda chamada (sem sessões) também é 204', async () => {
    const mobile = await signup('mobile', ana);
    await login('web', ana);

    await logoutAll(mobile).expect(204);
    await logoutAll(mobile).expect(204);

    expect(
      logs
        .events()
        .filter((e) => e.event === 'logout_all')
        .map((e) => e.sessionsRemoved),
    ).toEqual([2, 0]);
  });

  it.each(CLIENT_TYPES)(
    '%s: um token já rotacionado (candidato à janela de tolerância) não renova depois do logout-all: 401 simples, sem par novo',
    async (type) => {
      const session = await signup(type, ana);
      const r0 = session.refreshToken;
      const r1 = session.client.refreshTokenOf(
        await refreshWith(type, r0).expect(200),
      )!;

      // R0 está exatamente no estado que a janela aceitaria: rotacionado
      // agora, tolerância não usada e sucessor ativo.
      const row0 = await t.prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: TokenService.hashToken(r0) },
      });
      expect(row0).toMatchObject({
        rotatedAt: expect.any(Date),
        graceUsedAt: null,
      });
      expect(
        await t.prisma.refreshToken.findUniqueOrThrow({
          where: { id: row0.successorId! },
        }),
      ).toMatchObject({ revokedAt: null });

      await logoutAll(session).expect(204);
      // Apagadas, e não só marcadas.
      expect(await rowsOf(session.userId)).toBe(0);
      logs.clear();

      for (const token of [r0, r1]) {
        const res = await refreshWith(type, token).expect(401);
        expect(res.body.message).toBe('Invalid refresh token');
        expect(res.body.refreshToken).toBeUndefined();
        expect(res.body.accessToken).toBeUndefined();
        expect(res.headers['set-cookie']).toBeUndefined();
      }

      // Nenhum par novo foi gravado, e a recusa foi "não encontrado": nem
      // janela de tolerância, nem detecção de reuso.
      expect(await rowsOf(session.userId)).toBe(0);
      const refreshEvents = logs
        .events()
        .filter((e) => e.event.startsWith('refresh_'));
      expect(refreshEvents.map((e) => [e.event, e.reason])).toEqual([
        ['refresh_invalid', 'not_found'],
        ['refresh_invalid', 'not_found'],
      ]);
    },
  );

  it('está documentado no Swagger: Bearer, X-Client-Type e as respostas', async () => {
    const res = await http().get('/docs-json').expect(200);
    const op = res.body.paths['/auth/logout-all'].post;

    expect(op.security).toEqual([{ bearer: [] }]);
    expect(op.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'X-Client-Type',
          in: 'header',
          required: true,
        }),
      ]),
    );
    expect(Object.keys(op.responses).sort()).toEqual([
      '204',
      '400',
      '401',
      '429',
    ]);
    expect(op.description).toMatch(/access token atual/);
  });
});

describe('POST /auth/logout-all: rate limit (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createAppWithEnv({}, { keepThrottling: true });
    await t.resetDb();
  });

  afterAll(async () => {
    await t.close();
    vi.unstubAllEnvs();
  });

  it('segue o limite estrito das rotas de auth: 429 após 10 por minuto', async () => {
    const signup = await request(t.app.getHttpServer())
      .post('/auth/signup')
      .set('X-Client-Type', 'mobile')
      .send(ana)
      .expect(201);
    const post = () =>
      request(t.app.getHttpServer())
        .post('/auth/logout-all')
        .set('X-Client-Type', 'mobile')
        .set('Authorization', `Bearer ${signup.body.accessToken}`);

    for (let i = 0; i < 10; i++) {
      await post().expect(204);
    }
    const res = await post().expect(429);
    expect(res.body).toMatchObject({
      statusCode: 429,
      path: '/auth/logout-all',
    });
  });
});
