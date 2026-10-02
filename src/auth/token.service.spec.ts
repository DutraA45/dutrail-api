import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SecurityContext } from '../security/security-context.js';
import { SecurityLogService } from '../security/security-log.service.js';
import {
  ACCESS_TOKEN_AUDIENCE,
  INVALID_REFRESH_TOKEN_MESSAGE,
  REFRESH_TOKEN_AUDIENCE,
} from './jwt.constants.js';
import { TokenService } from './token.service.js';

const env = {
  JWT_SECRET: 'access-secret-0000000000000000000000000000000000',
  JWT_REFRESH_SECRET: 'refresh-secret-000000000000000000000000000000000',
  JWT_ISSUER: 'dutrail-api',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
  REFRESH_GRACE_SECONDS: 30,
};

/** Claims que o TokenService põe e confere no refresh token. */
const refreshClaims = {
  issuer: env.JWT_ISSUER,
  audience: REFRESH_TOKEN_AUDIENCE,
};

/**
 * Toda recusa de refresh token recebido sai com a mesma mensagem (A-18):
 * `toThrow(string)` aceitaria substring, então a comparação é exata.
 */
async function expectInvalidRefresh(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error('esperava 401');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UnauthorizedException);
  expect((err as UnauthorizedException).message).toBe(
    INVALID_REFRESH_TOKEN_MESSAGE,
  );
}

const user = { id: 'user-1' };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ctx: SecurityContext = { ip: '203.0.113.7', clientType: 'mobile' };

// Só os métodos do Prisma que o TokenService usa. Usar `vi.fn()` por método
// deixa cada teste dizer exatamente o que o banco "responde".
function createPrismaMock() {
  return {
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // A transação recebe o próprio mock como `tx`: cada teste vê, nos mesmos
    // vi.fn(), o que foi feito dentro e fora dela.
    $transaction: vi.fn(),
  };
}

describe('TokenService', () => {
  let service: TokenService;
  let jwt: JwtService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let securityLog: { log: any; warn: any };
  let config: typeof env;

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => unknown) => fn(prisma),
    );
    securityLog = { log: vi.fn(), warn: vi.fn() };
    config = { ...env };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TokenService,
        JwtService,
        { provide: PrismaService, useValue: prisma },
        { provide: SecurityLogService, useValue: securityLog },
        {
          provide: ConfigService,
          useValue: { get: (key: keyof typeof env) => config[key] },
        },
      ],
    }).compile();

    service = moduleRef.get(TokenService);
    jwt = moduleRef.get(JwtService);
  });

  describe('issueTokenPair', () => {
    it('emite access e refresh com HS256, iss e aud próprios de cada tipo', async () => {
      prisma.refreshToken.create.mockResolvedValue({});

      const { accessToken, refreshToken } = await service.issueTokenPair(user);

      const access = jwt.decode<Record<string, unknown>>(accessToken, {
        complete: true,
      });
      expect(access).toMatchObject({
        header: { alg: 'HS256' },
        payload: { iss: 'dutrail-api', aud: ACCESS_TOKEN_AUDIENCE },
      });
      const refresh = jwt.decode<Record<string, unknown>>(refreshToken, {
        complete: true,
      });
      expect(refresh).toMatchObject({
        header: { alg: 'HS256' },
        payload: { iss: 'dutrail-api', aud: REFRESH_TOKEN_AUDIENCE },
      });
    });

    it('emite access e refresh assinados com segredos diferentes', async () => {
      prisma.refreshToken.create.mockResolvedValue({});

      const { accessToken, refreshToken } = await service.issueTokenPair(user);

      const access = jwt.verify<Record<string, unknown>>(accessToken, {
        secret: env.JWT_SECRET,
      });
      expect(access).toMatchObject({ sub: user.id });
      // A-21: sem PII no payload, que é só base64.
      expect(access).not.toHaveProperty('email');

      const refresh = jwt.verify<{ sub: string; jti: string }>(refreshToken, {
        secret: env.JWT_REFRESH_SECRET,
      });
      expect(refresh.sub).toBe(user.id);
      expect(refresh.jti).toBeTypeOf('string');

      // Um token não pode ser aceito no lugar do outro.
      expect(() =>
        jwt.verify(accessToken, { secret: env.JWT_REFRESH_SECRET }),
      ).toThrow();
      expect(() =>
        jwt.verify(refreshToken, { secret: env.JWT_SECRET }),
      ).toThrow();
    });

    it('persiste apenas o SHA-256 do refresh token, com a expiração do JWT', async () => {
      prisma.refreshToken.create.mockResolvedValue({});

      const { refreshToken } = await service.issueTokenPair(user);

      const expectedHash = createHash('sha256')
        .update(refreshToken)
        .digest('hex');
      const { exp } = jwt.decode<{ exp: number }>(refreshToken);
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          tokenHash: expectedHash,
          userId: user.id,
          familyId: expect.stringMatching(UUID),
          expiresAt: new Date(exp * 1000),
        },
      });
      const data = prisma.refreshToken.create.mock.calls[0][0].data;
      expect(JSON.stringify(data)).not.toContain(refreshToken);
    });

    it('gera refresh tokens distintos em chamadas consecutivas (jti)', async () => {
      prisma.refreshToken.create.mockResolvedValue({});
      const a = await service.issueTokenPair(user);
      const b = await service.issueTokenPair(user);
      expect(a.refreshToken).not.toBe(b.refreshToken);
    });

    it('cada emissão (login, signup, troca do Google) abre uma família nova', async () => {
      prisma.refreshToken.create.mockResolvedValue({});
      await service.issueTokenPair(user);
      await service.issueTokenPair(user);

      const [a, b] = prisma.refreshToken.create.mock.calls.map(
        (call) => call[0].data.familyId,
      );
      expect(a).toMatch(UUID);
      expect(b).toMatch(UUID);
      expect(a).not.toBe(b);
    });
  });

  describe('rotateRefreshToken', () => {
    const futureDate = () => new Date(Date.now() + 60_000);
    const pastDate = () => new Date(Date.now() - 60_000);
    const familyId = 'fam-1';

    async function issue() {
      prisma.refreshToken.create.mockResolvedValue({});
      const pair = await service.issueTokenPair(user);
      prisma.refreshToken.create.mockClear();
      return pair;
    }

    /** Linha ativa (pode rotacionar). */
    function activeRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'rt-1',
        userId: user.id,
        familyId,
        revokedAt: null,
        rotatedAt: null,
        successorId: null,
        graceUsedAt: null,
        expiresAt: futureDate(),
        user,
        ...overrides,
      };
    }

    /** Linha rotacionada há `agoMs` ms, com sucessor `rt-2`. */
    function rotatedRow(
      agoMs = 1_000,
      overrides: Record<string, unknown> = {},
    ) {
      const rotatedAt = new Date(Date.now() - agoMs);
      return activeRow({
        revokedAt: rotatedAt,
        rotatedAt,
        successorId: 'rt-2',
        ...overrides,
      });
    }

    /** Responde ao findUnique da linha (por hash) e do sucessor (por id). */
    function mockRows(
      row: Record<string, unknown> | null,
      successor: { revokedAt: Date | null } | null = { revokedAt: null },
    ) {
      prisma.refreshToken.findUnique.mockImplementation(
        ({ where }: { where: { id?: string } }) =>
          Promise.resolve(where.id === 'rt-2' ? successor : row),
      );
    }

    function expectFamilyDeleted() {
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { familyId },
      });
      expect(securityLog.warn).toHaveBeenCalledWith(
        'refresh_reuse_detected',
        ctx,
        { userId: user.id, familyId },
      );
    }

    function expectNoWrites() {
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('A-17: numa transação, CAS em revokedAt/rotatedAt, sucessor na mesma família e successorId no antigo', async () => {
      const { refreshToken } = await issue();
      mockRows(activeRow());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt-2' });
      prisma.refreshToken.update.mockResolvedValue({});

      const pair = await service.rotateRefreshToken(refreshToken, ctx);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt-1', revokedAt: null },
        data: { revokedAt: expect.any(Date), rotatedAt: expect.any(Date) },
      });
      const { data } = prisma.refreshToken.updateMany.mock.calls[0][0];
      expect(data.rotatedAt).toEqual(data.revokedAt);
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          tokenHash: TokenService.hashToken(pair.refreshToken),
          userId: user.id,
          familyId,
          expiresAt: pair.refreshTokenExpiresAt,
        },
      });
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: { successorId: 'rt-2' },
      });
      expect(pair.refreshToken).not.toBe(refreshToken);
      expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
      expect(securityLog.log).toHaveBeenCalledWith('refresh_success', ctx, {
        userId: user.id,
        familyId,
      });
    });

    it('A-17: se o create do sucessor falhar, o erro sai da transação e não há sucesso', async () => {
      const { refreshToken } = await issue();
      mockRows(activeRow());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.refreshToken.create.mockRejectedValue(new Error('insert falhou'));

      await expect(
        service.rotateRefreshToken(refreshToken, ctx),
      ).rejects.toThrow('insert falhou');
      // O rollback de verdade é do Postgres (coberto no e2e); aqui, o erro
      // tem de escapar do callback para a transação desfazer o CAS.
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(securityLog.log).not.toHaveBeenCalled();
    });

    it('rejeita token com assinatura inválida sem consultar o banco', async () => {
      const forged = jwt.sign(
        { sub: user.id, jti: 'x' },
        { secret: 'outro-segredo', expiresIn: '1d', ...refreshClaims },
      );

      await expectInvalidRefresh(service.rotateRefreshToken(forged, ctx));
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
        reason: 'invalid_jwt',
      });
    });

    it('JWT expirado: 401 com reason "expired" no log', async () => {
      const expired = jwt.sign(
        { sub: user.id, jti: 'x', exp: Math.floor(Date.now() / 1000) - 10 },
        { secret: env.JWT_REFRESH_SECRET, ...refreshClaims },
      );

      await expectInvalidRefresh(service.rotateRefreshToken(expired, ctx));
      expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
        reason: 'expired',
      });
    });

    it('rejeita token assinado com o segredo do ACCESS token', async () => {
      const wrongKind = jwt.sign(
        { sub: user.id },
        { secret: env.JWT_SECRET, expiresIn: '15m' },
      );
      await expectInvalidRefresh(service.rotateRefreshToken(wrongKind, ctx));
    });

    it.each([
      [
        'aud de access token',
        { ...refreshClaims, audience: ACCESS_TOKEN_AUDIENCE },
      ],
      ['sem aud', { issuer: env.JWT_ISSUER }],
      ['outro iss', { ...refreshClaims, issuer: 'outro-servico' }],
      ['sem iss nem aud (formato anterior ao A-14)', {}],
      ['algoritmo HS384', { ...refreshClaims, algorithm: 'HS384' as const }],
    ])(
      'rejeita token com o segredo certo mas %s, sem consultar o banco',
      async (_label, claims) => {
        const token = jwt.sign(
          { sub: user.id, jti: 'x' },
          { secret: env.JWT_REFRESH_SECRET, expiresIn: '1d', ...claims },
        );

        await expectInvalidRefresh(service.rotateRefreshToken(token, ctx));
        expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
        expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
          reason: 'invalid_jwt',
        });
      },
    );

    it('linha inexistente: 401 simples, sem efeito colateral', async () => {
      const { refreshToken } = await issue();
      mockRows(null);

      await expectInvalidRefresh(service.rotateRefreshToken(refreshToken, ctx));
      expectNoWrites();
      expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
        userId: user.id,
        reason: 'not_found',
      });
    });

    it('rejeita token expirado no banco, mesmo rotacionado dentro da janela', async () => {
      const { refreshToken } = await issue();
      mockRows(rotatedRow(1_000, { expiresAt: pastDate() }));

      await expectInvalidRefresh(service.rotateRefreshToken(refreshToken, ctx));
      expectNoWrites();
      expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
        userId: user.id,
        familyId,
        reason: 'expired',
      });
    });

    describe('reapresentação de token rotacionado', () => {
      it('dentro da janela, com o sucessor ativo: par irmão na mesma família, sem tocar no sucessor', async () => {
        const { refreshToken } = await issue();
        mockRows(rotatedRow());
        prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
        prisma.refreshToken.create.mockResolvedValue({ id: 'rt-3' });

        const pair = await service.rotateRefreshToken(refreshToken, ctx);

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        // CAS de uso único da tolerância...
        expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
          where: { id: 'rt-1', graceUsedAt: null },
          data: { graceUsedAt: expect.any(Date) },
        });
        // ...e um token irmão na mesma família.
        expect(prisma.refreshToken.create).toHaveBeenCalledWith({
          data: {
            tokenHash: TokenService.hashToken(pair.refreshToken),
            userId: user.id,
            familyId,
            expiresAt: pair.refreshTokenExpiresAt,
          },
        });
        // O sucessor original segue intacto (a outra aba continua logada).
        expect(prisma.refreshToken.update).not.toHaveBeenCalled();
        expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
        expect(securityLog.warn).toHaveBeenCalledWith(
          'refresh_grace_used',
          ctx,
          { userId: user.id, familyId },
        );
        expect(securityLog.log).not.toHaveBeenCalled();
      });

      it('borda da janela (fake timers): exatamente REFRESH_GRACE_SECONDS ainda vale; 1 ms depois é reuso', async () => {
        const { refreshToken } = await issue();
        vi.useFakeTimers({ toFake: ['Date'] });
        const rotatedAt = new Date('2026-10-01T12:00:00.000Z');
        const row = activeRow({
          revokedAt: rotatedAt,
          rotatedAt,
          successorId: 'rt-2',
          expiresAt: new Date('2026-10-08T12:00:00.000Z'),
        });
        mockRows(row);
        prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
        prisma.refreshToken.create.mockResolvedValue({ id: 'rt-3' });

        vi.setSystemTime(rotatedAt.getTime() + 30_000);
        await service.rotateRefreshToken(refreshToken, ctx);
        expect(securityLog.warn).toHaveBeenLastCalledWith(
          'refresh_grace_used',
          ctx,
          { userId: user.id, familyId },
        );

        vi.setSystemTime(rotatedAt.getTime() + 30_001);
        prisma.refreshToken.updateMany.mockClear();
        await expectInvalidRefresh(
          service.rotateRefreshToken(refreshToken, ctx),
        );
        // Fora da janela nem tenta o CAS da tolerância.
        expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
        expectFamilyDeleted();
      });

      it('tolerância já usada (CAS em graceUsedAt perde): reuso, apaga a família', async () => {
        const { refreshToken } = await issue();
        mockRows(rotatedRow(1_000, { graceUsedAt: new Date() }));
        prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

        await expectInvalidRefresh(
          service.rotateRefreshToken(refreshToken, ctx),
        );
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
        expectFamilyDeleted();
        expect(securityLog.warn).not.toHaveBeenCalledWith(
          'refresh_grace_used',
          expect.anything(),
          expect.anything(),
        );
      });

      it('sucessor já rotacionado: reuso mesmo dentro da janela', async () => {
        const { refreshToken } = await issue();
        mockRows(rotatedRow(), { revokedAt: new Date() });

        await expectInvalidRefresh(
          service.rotateRefreshToken(refreshToken, ctx),
        );
        expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
        expectFamilyDeleted();
      });

      it('fora da janela: reuso, apaga só a família (nunca por userId)', async () => {
        const { refreshToken } = await issue();
        mockRows(rotatedRow(31_000));

        await expectInvalidRefresh(
          service.rotateRefreshToken(refreshToken, ctx),
        );
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
        expectFamilyDeleted();
        const { where } = prisma.refreshToken.deleteMany.mock.calls[0][0];
        expect(where).not.toHaveProperty('userId');
      });

      it('registra o reuso antes de apagar a família', async () => {
        const { refreshToken } = await issue();
        mockRows(rotatedRow(31_000));

        await expectInvalidRefresh(
          service.rotateRefreshToken(refreshToken, ctx),
        );
        const logged = securityLog.warn.mock.invocationCallOrder[0];
        const deleted =
          prisma.refreshToken.deleteMany.mock.invocationCallOrder[0];
        expect(logged).toBeLessThan(deleted);
      });

      it('REFRESH_GRACE_SECONDS=0 desativa a tolerância: reapresentar já é reuso', async () => {
        config.REFRESH_GRACE_SECONDS = 0;
        const { refreshToken } = await issue();
        mockRows(rotatedRow(0));

        await expectInvalidRefresh(
          service.rotateRefreshToken(refreshToken, ctx),
        );
        expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
        expectFamilyDeleted();
      });

      it('sucessor apagado (logout, A-01): 401 simples, sem efeito colateral', async () => {
        const { refreshToken } = await issue();
        mockRows(rotatedRow(), null);

        await expectInvalidRefresh(
          service.rotateRefreshToken(refreshToken, ctx),
        );
        expectNoWrites();
        expect(securityLog.warn).toHaveBeenCalledTimes(1);
        expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
          userId: user.id,
          familyId,
          reason: 'not_found',
        });
      });

      it('linha revogada antes da migration de famílias (sem rotatedAt): reuso, apaga só a família dela', async () => {
        const { refreshToken } = await issue();
        mockRows(activeRow({ revokedAt: pastDate() }));

        await expectInvalidRefresh(
          service.rotateRefreshToken(refreshToken, ctx),
        );
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
        expectFamilyDeleted();
      });
    });

    describe('CAS da rotação perde (outra request rotacionou antes)', () => {
      it('não devolve erro direto: recarrega a linha e usa a janela de tolerância', async () => {
        const { refreshToken } = await issue();
        // 1ª leitura: ainda ativa. Depois do CAS perdido: já rotacionada.
        prisma.refreshToken.findUnique
          .mockResolvedValueOnce(activeRow())
          .mockResolvedValueOnce(rotatedRow(10))
          .mockResolvedValueOnce({ revokedAt: null }); // sucessor
        prisma.refreshToken.updateMany
          .mockResolvedValueOnce({ count: 0 }) // CAS da rotação
          .mockResolvedValueOnce({ count: 1 }); // CAS da tolerância
        prisma.refreshToken.create.mockResolvedValue({ id: 'rt-3' });

        await service.rotateRefreshToken(refreshToken, ctx);

        expect(prisma.refreshToken.findUnique).toHaveBeenNthCalledWith(2, {
          where: { id: 'rt-1' },
        });
        expect(prisma.refreshToken.update).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
        expect(securityLog.warn).toHaveBeenCalledWith(
          'refresh_grace_used',
          ctx,
          { userId: user.id, familyId },
        );
      });

      it('linha apagada nesse meio-tempo: 401 simples', async () => {
        const { refreshToken } = await issue();
        prisma.refreshToken.findUnique
          .mockResolvedValueOnce(activeRow())
          .mockResolvedValueOnce(null);
        prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

        await expectInvalidRefresh(
          service.rotateRefreshToken(refreshToken, ctx),
        );
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
        expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
        expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
          userId: user.id,
          familyId,
          reason: 'not_found',
        });
      });
    });
  });

  describe('revokeRefreshToken', () => {
    it('apaga o token pelo hash', async () => {
      prisma.refreshToken.create.mockResolvedValue({});
      const { refreshToken } = await service.issueTokenPair(user);
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });

      await service.revokeRefreshToken(refreshToken, ctx);

      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { tokenHash: TokenService.hashToken(refreshToken) },
      });
      expect(securityLog.log).toHaveBeenCalledWith('logout', ctx, {
        userId: user.id,
        reason: undefined,
      });
    });

    it('rejeita token com assinatura inválida', async () => {
      await expect(
        service.revokeRefreshToken('a.b.c', ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith('logout', ctx, {
        reason: 'invalid_jwt',
      });
    });
  });
});
