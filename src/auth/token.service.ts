import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RefreshToken } from '../generated/prisma/client.js';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
} from './interfaces/jwt-payload.interface.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Emissão, rotação e revogação de tokens.
 *
 * Access token: JWT curto (JWT_ACCESS_TTL), stateless — validado apenas pela
 * assinatura na JwtStrategy, sem ir ao banco.
 *
 * Refresh token: JWT longo (JWT_REFRESH_TTL) assinado com OUTRO segredo, e
 * cujo SHA-256 é persistido. Isso permite revogar (logout), rotacionar e
 * detectar reuso. Guardar só o hash significa que um dump do banco não dá
 * sessões válidas a ninguém.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /**
   * SHA-256 (rápido) em vez de argon2 (lento, com salt) porque o token já tem
   * ~256 bits de entropia — ninguém vai "adivinhá-lo" por força bruta — e o
   * hash determinístico permite buscar por igualdade com índice único.
   */
  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Gera access + refresh e persiste o hash do refresh. */
  async issueTokenPair(user: {
    id: string;
    email: string;
  }): Promise<TokenPair> {
    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
    };
    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get('JWT_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
    });

    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      jti: randomUUID(),
    };
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }),
    });

    // Lê o `exp` calculado pelo jsonwebtoken em vez de parsear "7d" de novo.
    const { exp } = this.jwt.decode<{ exp: number }>(refreshToken);
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: TokenService.hashToken(refreshToken),
        userId: user.id,
        expiresAt: new Date(exp * 1000),
      },
    });

    return { accessToken, refreshToken };
  }

  /**
   * Rotação: valida o refresh token recebido, revoga-o atomicamente e devolve
   * um par novo. Qualquer falha vira o mesmo 401 genérico para não dar pistas.
   */
  async rotateRefreshToken(refreshToken: string): Promise<TokenPair> {
    const stored = await this.findValidRefreshToken(refreshToken);

    // Compare-and-set: só quem conseguir marcar `revokedAt` (de null para
    // agora) segue em frente. Se dois requests concorrentes usarem o mesmo
    // token, apenas um ganha; o outro cai no 401 abaixo.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return this.issueTokenPair(stored.user);
  }

  /**
   * Logout: apaga o refresh token. Idempotente — se não existe (mas a
   * assinatura é válida), não há nada a fazer.
   *
   * Apagar (em vez de marcar `revokedAt`) é proposital: um token deslogado
   * que volte a aparecer vira um simples "não encontrado" (401), sem acionar
   * a detecção de reuso — que derrubaria as outras sessões do usuário por
   * causa de, digamos, um retry do cliente web.
   */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    this.verifyRefreshJwt(refreshToken);
    await this.prisma.refreshToken.deleteMany({
      where: { tokenHash: TokenService.hashToken(refreshToken) },
    });
  }

  /** Derruba todas as sessões ativas do usuário (usado na detecção de reuso). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Passo 1 (barato): assinatura + expiração do JWT.
   * Passo 2: existe no banco, não expirou e não foi revogado.
   */
  private async findValidRefreshToken(
    refreshToken: string,
  ): Promise<RefreshToken & { user: { id: string; email: string } }> {
    this.verifyRefreshJwt(refreshToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: TokenService.hashToken(refreshToken) },
      include: { user: { select: { id: true, email: true } } },
    });

    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (stored.revokedAt) {
      // Um token já rotacionado/deslogado voltou a aparecer. Ou o cliente
      // legítimo está reenviando um token antigo (bug), ou alguém roubou o
      // token e o legítimo já o rotacionou. Nos dois casos, a única resposta
      // segura é invalidar todas as sessões e forçar novo login.
      await this.revokeAllForUser(stored.userId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    return stored;
  }

  private verifyRefreshJwt(refreshToken: string): RefreshTokenPayload {
    try {
      return this.jwt.verify<RefreshTokenPayload>(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }
}
