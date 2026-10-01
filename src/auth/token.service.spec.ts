import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SecurityContext } from '../security/security-context.js';
import { SecurityLogService } from '../security/security-log.service.js';
import { TokenService } from './token.service.js';

const env = {
  JWT_SECRET: 'access-secret-0000000000000000000000000000000000',
  JWT_REFRESH_SECRET: 'refresh-secret-000000000000000000000000000000000',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
};

const user = { id: 'user-1', email: 'ana@example.com' };
const ctx: SecurityContext = { ip: '203.0.113.7', clientType: 'mobile' };

// Só os métodos do Prisma que o TokenService usa. Usar `vi.fn()` por método
// deixa cada teste dizer exatamente o que o banco "responde".
function createPrismaMock() {
  return {
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

describe('TokenService', () => {
  let service: TokenService;
  let jwt: JwtService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let securityLog: { log: any; warn: any };

  beforeEach(async () => {
    prisma = createPrismaMock();
    securityLog = { log: vi.fn(), warn: vi.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TokenService,
        JwtService,
        { provide: PrismaService, useValue: prisma },
        { provide: SecurityLogService, useValue: securityLog },
        {
          provide: ConfigService,
          useValue: { get: (key: keyof typeof env) => env[key] },
        },
      ],
    }).compile();

    service = moduleRef.get(TokenService);
    jwt = moduleRef.get(JwtService);
  });

  describe('issueTokenPair', () => {
    it('emite access e refresh assinados com segredos diferentes', async () => {
      prisma.refreshToken.create.mockResolvedValue({});

      const { accessToken, refreshToken } = await service.issueTokenPair(user);

      const access = jwt.verify<{ sub: string; email: string }>(accessToken, {
        secret: env.JWT_SECRET,
      });
      expect(access).toMatchObject({ sub: user.id, email: user.email });

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
  });

  describe('rotateRefreshToken', () => {
    const futureDate = () => new Date(Date.now() + 60_000);
    const pastDate = () => new Date(Date.now() - 60_000);

    async function issue() {
      prisma.refreshToken.create.mockResolvedValue({});
      const pair = await service.issueTokenPair(user);
      prisma.refreshToken.create.mockClear();
      return pair;
    }

    it('revoga o token antigo e emite um par novo', async () => {
      const { refreshToken } = await issue();
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: user.id,
        revokedAt: null,
        expiresAt: futureDate(),
        user,
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.refreshToken.create.mockResolvedValue({});

      const pair = await service.rotateRefreshToken(refreshToken, ctx);

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(pair.refreshToken).not.toBe(refreshToken);
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      expect(securityLog.log).toHaveBeenCalledWith('refresh_success', ctx, {
        userId: user.id,
      });
    });

    it('rejeita token com assinatura inválida sem consultar o banco', async () => {
      const forged = jwt.sign(
        { sub: user.id, jti: 'x' },
        { secret: 'outro-segredo', expiresIn: '1d' },
      );

      await expect(
        service.rotateRefreshToken(forged, ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
        reason: 'invalid_jwt',
      });
    });

    it('JWT expirado: 401 com reason "expired" no log', async () => {
      const expired = jwt.sign(
        { sub: user.id, jti: 'x', exp: Math.floor(Date.now() / 1000) - 10 },
        { secret: env.JWT_REFRESH_SECRET },
      );

      await expect(
        service.rotateRefreshToken(expired, ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
        reason: 'expired',
      });
    });

    it('rejeita token assinado com o segredo do ACCESS token', async () => {
      const wrongKind = jwt.sign(
        { sub: user.id, email: user.email },
        { secret: env.JWT_SECRET, expiresIn: '15m' },
      );
      await expect(
        service.rotateRefreshToken(wrongKind, ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejeita token válido mas desconhecido no banco', async () => {
      const { refreshToken } = await issue();
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(
        service.rotateRefreshToken(refreshToken, ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
        userId: user.id,
        reason: 'not_found',
      });
    });

    it('detecta reuso: token já revogado derruba todas as sessões do usuário', async () => {
      const { refreshToken } = await issue();
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: user.id,
        revokedAt: pastDate(),
        expiresAt: futureDate(),
        user,
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });

      await expect(
        service.rotateRefreshToken(refreshToken, ctx),
      ).rejects.toThrow('reuse');
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith(
        'refresh_reuse_detected',
        ctx,
        { userId: user.id },
      );
    });

    it('rejeita token expirado no banco', async () => {
      const { refreshToken } = await issue();
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: user.id,
        revokedAt: null,
        expiresAt: pastDate(),
        user,
      });

      await expect(
        service.rotateRefreshToken(refreshToken, ctx),
      ).rejects.toThrow('expired');
      expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
        userId: user.id,
        reason: 'expired',
      });
    });

    it('perde a corrida de rotação concorrente (compare-and-set) -> 401', async () => {
      const { refreshToken } = await issue();
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: user.id,
        revokedAt: null,
        expiresAt: futureDate(),
        user,
      });
      // Outro request revogou entre o findUnique e o updateMany.
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.rotateRefreshToken(refreshToken, ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith('refresh_invalid', ctx, {
        userId: user.id,
        reason: 'concurrent_rotation',
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
