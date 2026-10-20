import { Logger } from '@nestjs/common';
import {
  CronExpression,
  ScheduleModule,
  SchedulerRegistry,
} from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ExpiredTokensCleanupService,
  PURGE_EXPIRED_TOKENS_JOB,
} from './expired-tokens-cleanup.service.js';

/**
 * Unidade: o filtro por `expiresAt`, as contagens, o log e o registro do cron.
 * O DELETE de verdade, contra o Postgres, está em
 * test/expired-tokens-cleanup.e2e-spec.ts.
 */
describe('ExpiredTokensCleanupService', () => {
  let prisma: {
    refreshToken: { deleteMany: any };
    oAuthExchangeCode: { deleteMany: any };
    $transaction: any;
  };
  const logSpy = vi
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  const errorSpy = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    prisma = {
      refreshToken: { deleteMany: vi.fn().mockResolvedValue({ count: 4 }) },
      oAuthExchangeCode: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
  });

  afterAll(() => vi.restoreAllMocks());

  const service = () =>
    new ExpiredTokensCleanupService(prisma as unknown as PrismaService);

  it('apaga só expiresAt < agora, nas duas tabelas, e devolve as contagens', async () => {
    const before = Date.now();
    await expect(service().purgeExpired()).resolves.toEqual({
      refreshTokens: 4,
      exchangeCodes: 1,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const rtWhere = prisma.refreshToken.deleteMany.mock.calls[0][0].where;
    const codeWhere =
      prisma.oAuthExchangeCode.deleteMany.mock.calls[0][0].where;
    // Só o prazo: nada de revokedAt/rotatedAt (rotacionados no prazo ficam).
    expect(Object.keys(rtWhere)).toEqual(['expiresAt']);
    expect(Object.keys(rtWhere.expiresAt)).toEqual(['lt']);
    expect(rtWhere.expiresAt.lt.getTime()).toBeGreaterThanOrEqual(before);
    expect(rtWhere.expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now());
    // O mesmo instante nas duas tabelas.
    expect(codeWhere).toEqual(rtWhere);
  });

  it('registra cada execução só com as contagens', async () => {
    await service().purgeExpired();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toBe(
      'Tokens expirados apagados: refreshTokens=4 exchangeCodes=1',
    );
  });

  it('a execução agendada não propaga erro nem registra a mensagem dele', async () => {
    prisma.$transaction.mockRejectedValue(
      new Error('falha com dado-sensivel@example.com'),
    );

    await expect(service().runScheduled()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('dado-sensivel');
  });

  it('com o ScheduleModule, registra o job diário pelo nome', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        ExpiredTokensCleanupService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    await moduleRef.init();

    const job = moduleRef
      .get(SchedulerRegistry)
      .getCronJob(PURGE_EXPIRED_TOKENS_JOB);
    expect(job.cronTime.source).toBe(CronExpression.EVERY_DAY_AT_3AM);
    await moduleRef.close();
  });
});
