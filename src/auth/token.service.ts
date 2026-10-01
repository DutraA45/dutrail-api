import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RefreshToken } from '../generated/prisma/client.js';
import type { SecurityContext } from '../security/security-context.js';
import { SecurityLogService } from '../security/security-log.service.js';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
} from './interfaces/jwt-payload.interface.js';
import {
  ACCESS_TOKEN_AUDIENCE,
  INVALID_REFRESH_TOKEN_MESSAGE,
  JWT_ALGORITHM,
  REFRESH_TOKEN_AUDIENCE,
} from './jwt.constants.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** `exp` do refresh token emitido; o mesmo prazo gravado no banco. */
  refreshTokenExpiresAt: Date;
}

/** Resultado da checagem do JWT: o payload, ou o motivo (para o log) da recusa. */
type RefreshJwtCheck =
  { payload: RefreshTokenPayload } | { reason: 'invalid_jwt' | 'expired' };

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
 *
 * Os dois levam `iss` (JWT_ISSUER) e um `aud` próprio do tipo, conferidos na
 * verificação junto com o algoritmo (A-14).
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly securityLog: SecurityLogService,
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
      algorithm: JWT_ALGORITHM,
      issuer: this.config.get('JWT_ISSUER', { infer: true }),
      audience: ACCESS_TOKEN_AUDIENCE,
    });

    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      jti: randomUUID(),
    };
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }),
      algorithm: JWT_ALGORITHM,
      issuer: this.config.get('JWT_ISSUER', { infer: true }),
      audience: REFRESH_TOKEN_AUDIENCE,
    });

    // Lê o `exp` calculado pelo jsonwebtoken em vez de parsear "7d" de novo.
    const { exp } = this.jwt.decode<{ exp: number }>(refreshToken);
    const refreshTokenExpiresAt = new Date(exp * 1000);
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: TokenService.hashToken(refreshToken),
        userId: user.id,
        expiresAt: refreshTokenExpiresAt,
      },
    });

    return { accessToken, refreshToken, refreshTokenExpiresAt };
  }

  /**
   * Rotação: valida o refresh token recebido, revoga-o atomicamente e devolve
   * um par novo. Toda recusa de um token recebido (JWT inválido ou expirado,
   * não encontrado, reuso, rotação concorrente) responde o mesmo 401 com
   * "Invalid refresh token", para não dar pistas a quem roubou o token; o
   * motivo fica só no log de segurança. Token ausente é tratado antes, no
   * controller, com "Missing refresh token".
   */
  async rotateRefreshToken(
    refreshToken: string,
    ctx: SecurityContext,
  ): Promise<TokenPair> {
    const stored = await this.findValidRefreshToken(refreshToken, ctx);

    // Compare-and-set: só quem conseguir marcar `revokedAt` (de null para
    // agora) segue em frente. Se dois requests concorrentes usarem o mesmo
    // token, apenas um ganha; o outro cai no 401 abaixo.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      this.securityLog.warn('refresh_invalid', ctx, {
        userId: stored.userId,
        reason: 'concurrent_rotation',
      });
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const pair = await this.issueTokenPair(stored.user);
    this.securityLog.log('refresh_success', ctx, { userId: stored.userId });
    return pair;
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
  async revokeRefreshToken(
    refreshToken: string,
    ctx: SecurityContext,
  ): Promise<void> {
    const check = this.verifyRefreshJwt(refreshToken);
    if ('reason' in check) {
      this.securityLog.warn('logout', ctx, { reason: check.reason });
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { tokenHash: TokenService.hashToken(refreshToken) },
    });
    this.securityLog.log('logout', ctx, {
      userId: check.payload.sub,
      reason: count === 0 ? 'not_found' : undefined,
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
    ctx: SecurityContext,
  ): Promise<RefreshToken & { user: { id: string; email: string } }> {
    const check = this.verifyRefreshJwt(refreshToken);
    if ('reason' in check) {
      this.securityLog.warn('refresh_invalid', ctx, { reason: check.reason });
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: TokenService.hashToken(refreshToken) },
      include: { user: { select: { id: true, email: true } } },
    });

    if (!stored) {
      // A assinatura é válida, então o `sub` é confiável: ajuda a ligar o
      // evento ao usuário (ex.: token apagado no logout sendo reenviado).
      this.securityLog.warn('refresh_invalid', ctx, {
        userId: check.payload.sub,
        reason: 'not_found',
      });
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    if (stored.revokedAt) {
      // Um token já rotacionado/deslogado voltou a aparecer. Ou o cliente
      // legítimo está reenviando um token antigo (bug), ou alguém roubou o
      // token e o legítimo já o rotacionou. Nos dois casos, a única resposta
      // segura é invalidar todas as sessões e forçar novo login.
      // Registrado antes da revogação: se ela falhar, o evento não se perde.
      this.securityLog.warn('refresh_reuse_detected', ctx, {
        userId: stored.userId,
      });
      await this.revokeAllForUser(stored.userId);
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      this.securityLog.warn('refresh_invalid', ctx, {
        userId: stored.userId,
        reason: 'expired',
      });
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    return stored;
  }

  /**
   * Não lança: quem chama registra o motivo e responde o 401. Algoritmo, `iss`
   * e `aud` fixados: sem isso o jsonwebtoken aceitaria HS384/HS512 e qualquer
   * emissor ou audiência.
   */
  private verifyRefreshJwt(refreshToken: string): RefreshJwtCheck {
    try {
      const payload = this.jwt.verify<RefreshTokenPayload>(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        algorithms: [JWT_ALGORITHM],
        issuer: this.config.get('JWT_ISSUER', { infer: true }),
        audience: REFRESH_TOKEN_AUDIENCE,
      });
      return { payload };
    } catch (err) {
      return {
        reason: err instanceof TokenExpiredError ? 'expired' : 'invalid_jwt',
      };
    }
  }
}
