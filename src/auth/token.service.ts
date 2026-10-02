import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma, RefreshToken } from '../generated/prisma/client.js';
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

/** Linha a gravar para um refresh token recém-assinado. */
function refreshTokenRow(
  pair: TokenPair,
  userId: string,
  familyId: string,
): Prisma.RefreshTokenUncheckedCreateInput {
  return {
    tokenHash: TokenService.hashToken(pair.refreshToken),
    userId,
    familyId,
    expiresAt: pair.refreshTokenExpiresAt,
  };
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
 *
 * Família (A-04): todos os refresh tokens de uma sessão (um login num
 * dispositivo) compartilham o `familyId`. O reuso derruba só a família, e um
 * token recém-rotacionado tem uma janela de tolerância de uso único
 * (REFRESH_GRACE_SECONDS) para respostas perdidas e abas concorrentes.
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

  /**
   * Gera access + refresh e persiste o hash do refresh numa família nova: é
   * o começo de uma sessão (login, signup, troca do código do Google).
   */
  async issueTokenPair(user: { id: string }): Promise<TokenPair> {
    const signed = await this.signTokenPair(user.id);
    await this.prisma.refreshToken.create({
      data: refreshTokenRow(signed, user.id, randomUUID()),
    });
    return signed;
  }

  /**
   * Rotação: valida o refresh token recebido, marca-o como rotacionado e
   * devolve um par novo na mesma família. Toda recusa de um token recebido
   * (JWT inválido ou expirado, não encontrado, reuso) responde o mesmo 401 com
   * "Invalid refresh token", para não dar pistas a quem roubou o token; o
   * motivo fica só no log de segurança. Token ausente é tratado antes, no
   * controller, com "Missing refresh token".
   */
  async rotateRefreshToken(
    refreshToken: string,
    ctx: SecurityContext,
  ): Promise<TokenPair> {
    const stored = await this.findRefreshToken(refreshToken, ctx);
    if (stored.revokedAt) {
      return this.handleRotatedToken(stored, ctx);
    }

    // A-17: CAS, sucessor e ligação numa transação só. Se qualquer passo
    // falhar, o token atual continua ativo e o cliente pode tentar de novo.
    const signed = await this.signTokenPair(stored.userId);
    const rotated = await this.prisma.$transaction(async (tx) => {
      // Compare-and-set: só quem conseguir marcar `revokedAt` (de null para
      // agora) emite o sucessor.
      const now = new Date();
      const { count } = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: now, rotatedAt: now },
      });
      if (count === 0) return false;

      const successor = await tx.refreshToken.create({
        data: refreshTokenRow(signed, stored.userId, stored.familyId),
      });
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { successorId: successor.id },
      });
      return true;
    });

    if (!rotated) {
      // Outra request com o mesmo token rotacionou antes (duas abas, retry
      // concorrente). O UPDATE desta esperou o lock da linha até a outra
      // transação terminar, então a linha recarregada já mostra o sucessor:
      // é uma reapresentação como outra qualquer.
      const current = await this.prisma.refreshToken.findUnique({
        where: { id: stored.id },
      });
      if (!current) {
        // Apagada nesse meio-tempo (logout, ou reuso detectado na família).
        this.securityLog.warn('refresh_invalid', ctx, {
          userId: stored.userId,
          familyId: stored.familyId,
          reason: 'not_found',
        });
        throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
      }
      return this.handleRotatedToken(current, ctx);
    }

    this.securityLog.log('refresh_success', ctx, {
      userId: stored.userId,
      familyId: stored.familyId,
    });
    return signed;
  }

  /**
   * Logout: apaga o refresh token. Idempotente — se não existe (mas a
   * assinatura é válida), não há nada a fazer.
   *
   * Apagar (em vez de marcar `revokedAt`) é proposital: um token deslogado
   * que volte a aparecer vira um simples "não encontrado" (401), sem passar
   * pela janela de tolerância nem pela detecção de reuso. O mesmo vale para o
   * token anterior a ele na família: o sucessor sumiu, então também é 401
   * simples (ver handleRotatedToken).
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

  /**
   * Reapresentação de um token que já saiu de uso (`revokedAt` preenchido):
   *
   * a. Rotacionado há no máximo REFRESH_GRACE_SECONDS, com o sucessor ainda
   *    ativo e a tolerância ainda não usada: emite um par irmão na mesma
   *    família, sem mexer no sucessor (resposta perdida, duas abas).
   * b. Sucessor apagado (logout, A-01): a sessão já acabou; 401 simples, sem
   *    efeito colateral.
   * c. Qualquer outro caso (fora da janela, tolerância já usada, sucessor já
   *    rotacionado): reuso. Apaga a família inteira; as outras sessões do
   *    usuário (outros dispositivos) continuam valendo.
   *
   * Linhas anteriores à migration de famílias têm `revokedAt` sem `rotatedAt`
   * e nenhum sucessor conhecido: caem direto no reuso, e a família delas é só
   * a própria linha.
   */
  private async handleRotatedToken(
    stored: RefreshToken,
    ctx: SecurityContext,
  ): Promise<TokenPair> {
    const details = { userId: stored.userId, familyId: stored.familyId };

    if (stored.rotatedAt) {
      const successor =
        stored.successorId === null
          ? null
          : await this.prisma.refreshToken.findUnique({
              where: { id: stored.successorId },
              select: { revokedAt: true },
            });
      if (!successor) {
        this.securityLog.warn('refresh_invalid', ctx, {
          ...details,
          reason: 'not_found',
        });
        throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
      }

      // Sucessor já rotacionado: o dono recebeu e usou o token novo, então
      // não houve resposta perdida. Quem reapresenta o antigo tem uma cópia.
      if (
        successor.revokedAt === null &&
        this.withinGraceWindow(stored.rotatedAt)
      ) {
        const pair = await this.issueGracePair(stored);
        if (pair) {
          // warn: legítimo na maioria das vezes, mas também é o que um
          // atacante com uma cópia recente do token conseguiria.
          this.securityLog.warn('refresh_grace_used', ctx, details);
          return pair;
        }
      }
    }

    // Registrado antes de apagar: se o DELETE falhar, o evento não se perde.
    this.securityLog.warn('refresh_reuse_detected', ctx, details);
    await this.prisma.refreshToken.deleteMany({
      where: { familyId: stored.familyId },
    });
    throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
  }

  /** 0 desativa a janela. */
  private withinGraceWindow(rotatedAt: Date): boolean {
    const graceSeconds = this.config.get('REFRESH_GRACE_SECONDS', {
      infer: true,
    });
    return (
      graceSeconds > 0 &&
      Date.now() - rotatedAt.getTime() <= graceSeconds * 1000
    );
  }

  /**
   * Uso único da janela: CAS em `graceUsedAt` e um token irmão do sucessor na
   * mesma família, numa transação. `undefined` se a tolerância já foi usada
   * (ou a linha sumiu) — quem chama trata como reuso.
   */
  private async issueGracePair(
    stored: RefreshToken,
  ): Promise<TokenPair | undefined> {
    const signed = await this.signTokenPair(stored.userId);
    const granted = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { id: stored.id, graceUsedAt: null },
        data: { graceUsedAt: new Date() },
      });
      if (count === 0) return false;

      await tx.refreshToken.create({
        data: refreshTokenRow(signed, stored.userId, stored.familyId),
      });
      return true;
    });
    return granted ? signed : undefined;
  }

  /** Assina access + refresh; quem chama decide onde persistir o refresh. */
  private async signTokenPair(userId: string): Promise<TokenPair> {
    const accessPayload: AccessTokenPayload = { sub: userId };
    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get('JWT_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
      algorithm: JWT_ALGORITHM,
      issuer: this.config.get('JWT_ISSUER', { infer: true }),
      audience: ACCESS_TOKEN_AUDIENCE,
    });

    const refreshPayload: RefreshTokenPayload = {
      sub: userId,
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
    return {
      accessToken,
      refreshToken,
      refreshTokenExpiresAt: new Date(exp * 1000),
    };
  }

  /**
   * Passo 1 (barato): assinatura + expiração do JWT.
   * Passo 2: existe no banco e não expirou. Se foi rotacionado, quem decide é
   * a rotação (janela de tolerância ou reuso).
   */
  private async findRefreshToken(
    refreshToken: string,
    ctx: SecurityContext,
  ): Promise<RefreshToken> {
    const check = this.verifyRefreshJwt(refreshToken);
    if ('reason' in check) {
      this.securityLog.warn('refresh_invalid', ctx, { reason: check.reason });
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: TokenService.hashToken(refreshToken) },
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

    // Antes do estado de rotação: um token expirado nunca ganha a janela de
    // tolerância. (O `exp` do JWT é o mesmo prazo; isto é a segunda barreira.)
    if (stored.expiresAt.getTime() <= Date.now()) {
      this.securityLog.warn('refresh_invalid', ctx, {
        userId: stored.userId,
        familyId: stored.familyId,
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
