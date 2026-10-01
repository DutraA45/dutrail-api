import { randomUUID } from 'node:crypto';
import { ExpiredTokensCleanupService } from '../src/auth/expired-tokens-cleanup.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { createClient } from './utils/client.js';
import { createTestApp, type TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';

/**
 * Limpeza de tokens expirados (A-12) contra o Postgres real. O .env.test tem
 * SCHEDULER_ENABLED=false: aqui o purgeExpired() é chamado direto, e o
 * registro do cron é conferido subindo a app com a flag ligada e desligada.
 */

const credentials = {
  email: 'ana@example.com',
  password: 'S3nh@Forte!',
  name: 'Ana',
};
const HOUR = 3_600_000;

describe('ExpiredTokensCleanupService.purgeExpired (e2e)', () => {
  let t: TestApp;
  let cleanup: ExpiredTokensCleanupService;

  beforeAll(async () => {
    t = await createTestApp();
    cleanup = t.app.get(ExpiredTokensCleanupService);
  });

  beforeEach(async () => {
    await t.resetDb();
  });

  afterAll(async () => {
    await t.close();
  });

  const rowOf = (token: string) =>
    t.prisma.refreshToken.findUnique({
      where: { tokenHash: TokenService.hashToken(token) },
    });

  /** Linha de refresh token inserida direto, com o prazo dado. */
  const refreshRow = (
    userId: string,
    expiresAt: Date,
    extra: { revokedAt?: Date; rotatedAt?: Date } = {},
  ) =>
    t.prisma.refreshToken.create({
      data: {
        tokenHash: TokenService.hashToken(randomUUID()),
        userId,
        familyId: randomUUID(),
        expiresAt,
        ...extra,
      },
    });

  const exchangeCode = (
    userId: string,
    expiresAt: Date,
    usedAt: Date | null = null,
  ) =>
    t.prisma.oAuthExchangeCode.create({
      data: {
        codeHash: TokenService.hashToken(randomUUID()),
        userId,
        expiresAt,
        usedAt,
      },
    });

  it('apaga só os expirados; válidos e rotacionados ainda no prazo ficam; devolve as contagens', async () => {
    const client = createClient(t.app, 'mobile');
    const signup = await client
      .post('/auth/signup')
      .send(credentials)
      .expect(201);
    const userId = signup.body.user.id as string;
    // R0 rotacionado (ainda no prazo) e R1, o sucessor ativo.
    const r0 = signup.body.refreshToken as string;
    const r1 = (await client.refreshWith(r0).expect(200)).body
      .refreshToken as string;

    const past = new Date(Date.now() - HOUR);
    const future = new Date(Date.now() + HOUR);
    const expiredActive = await refreshRow(userId, past);
    const expiredRotated = await refreshRow(userId, past, {
      revokedAt: past,
      rotatedAt: past,
    });
    const revokedInTime = await refreshRow(userId, future, {
      revokedAt: new Date(),
      rotatedAt: new Date(),
    });
    const expiredCode = await exchangeCode(userId, past);
    const expiredUsedCode = await exchangeCode(userId, past, new Date());
    const pendingCode = await exchangeCode(userId, future);
    const usedInTimeCode = await exchangeCode(userId, future, new Date());

    await expect(cleanup.purgeExpired()).resolves.toEqual({
      refreshTokens: 2,
      exchangeCodes: 2,
    });

    const refreshIds = (
      await t.prisma.refreshToken.findMany({ select: { id: true } })
    ).map((r) => r.id);
    expect(refreshIds.sort()).toEqual(
      [(await rowOf(r0))!.id, (await rowOf(r1))!.id, revokedInTime.id].sort(),
    );
    expect(refreshIds).not.toContain(expiredActive.id);
    expect(refreshIds).not.toContain(expiredRotated.id);

    const codeIds = (
      await t.prisma.oAuthExchangeCode.findMany({ select: { id: true } })
    ).map((c) => c.id);
    expect(codeIds.sort()).toEqual([pendingCode.id, usedInTimeCode.id].sort());
    expect(codeIds).not.toContain(expiredCode.id);
    expect(codeIds).not.toContain(expiredUsedCode.id);

    // A sessão segue: R1 rotaciona normalmente.
    await client.refreshWith(r1).expect(200);

    // Nada mais a apagar.
    await expect(cleanup.purgeExpired()).resolves.toEqual({
      refreshTokens: 0,
      exchangeCodes: 0,
    });
  });

  it('o rotacionado preservado continua detectando reuso', async () => {
    const client = createClient(t.app, 'mobile');
    const signup = await client
      .post('/auth/signup')
      .send(credentials)
      .expect(201);
    const r0 = signup.body.refreshToken as string;
    const r1 = (await client.refreshWith(r0).expect(200)).body
      .refreshToken as string;
    const { familyId } = (await rowOf(r0))!;
    // Fora da janela de tolerância, mas longe do expiresAt.
    await t.prisma.refreshToken.update({
      where: { tokenHash: TokenService.hashToken(r0) },
      data: { rotatedAt: new Date(Date.now() - HOUR) },
    });

    await cleanup.purgeExpired();
    expect(await rowOf(r0)).not.toBeNull();

    // Reapresentar R0 é reuso: a família cai, R1 junto.
    await client.refreshWith(r0).expect(401);
    expect(await t.prisma.refreshToken.count({ where: { familyId } })).toBe(0);
    await client.refreshWith(r1).expect(401);
  });
});

describe('Registro do job de limpeza (e2e)', () => {
  /**
   * Sobe a app com a flag dada. SchedulerRegistry e o nome do job vêm do
   * mesmo carregamento de módulos que a app (o createAppWithEnv reimporta).
   */
  async function bootWith(flag: 'true' | 'false') {
    const t = await createAppWithEnv({ SCHEDULER_ENABLED: flag });
    const { SchedulerRegistry } = await import('@nestjs/schedule');
    const { PURGE_EXPIRED_TOKENS_JOB } =
      await import('../src/auth/expired-tokens-cleanup.service.js');
    return { t, SchedulerRegistry, PURGE_EXPIRED_TOKENS_JOB };
  }

  afterAll(() => vi.unstubAllEnvs());

  it('SCHEDULER_ENABLED=true: o job diário é registrado', async () => {
    const { t, SchedulerRegistry, PURGE_EXPIRED_TOKENS_JOB } =
      await bootWith('true');
    try {
      const registry = t.app.get(SchedulerRegistry, { strict: false });
      expect([...registry.getCronJobs().keys()]).toEqual([
        PURGE_EXPIRED_TOKENS_JOB,
      ]);
    } finally {
      await t.close();
    }
  });

  it('SCHEDULER_ENABLED=false: o ScheduleModule nem é importado, nenhum job registrado', async () => {
    const { t, SchedulerRegistry } = await bootWith('false');
    try {
      expect(() => t.app.get(SchedulerRegistry, { strict: false })).toThrow();
    } finally {
      await t.close();
    }
  });
});
