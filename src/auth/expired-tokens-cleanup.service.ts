import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';

/** Nome do job no SchedulerRegistry. */
export const PURGE_EXPIRED_TOKENS_JOB = 'purge-expired-tokens';

export interface PurgeExpiredResult {
  refreshTokens: number;
  exchangeCodes: number;
}

/**
 * Limpeza diária (A-12) dos `RefreshToken` e `OAuthExchangeCode` cujo
 * `expiresAt` já passou. Sem ela as tabelas crescem sem limite e guardam
 * metadados de sessão (userId, horários) além do necessário.
 *
 * Só apaga o que expirou: um token rotacionado ainda dentro do `expiresAt`
 * continua no banco, porque é ele que faz a janela de tolerância e a detecção
 * de reuso funcionarem. Depois do `expiresAt` o JWT também expirou (é o mesmo
 * prazo), então a linha não serve para mais nada.
 *
 * O @Cron só vale quando o ScheduleModule está registrado (SCHEDULER_ENABLED,
 * ver AppModule). Assume uma única instância da API: com mais de uma, cada
 * uma rodaria o job (os DELETEs são idempotentes, mas seria preciso um lock
 * para não repetir o trabalho).
 */
@Injectable()
export class ExpiredTokensCleanupService {
  private readonly logger = new Logger(ExpiredTokensCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: PURGE_EXPIRED_TOKENS_JOB,
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async runScheduled(): Promise<void> {
    try {
      await this.purgeExpired();
    } catch (err) {
      // Só o tipo do erro: a mensagem de um erro de banco pode trazer dados.
      // A próxima execução tenta de novo.
      this.logger.error(
        `Limpeza de tokens expirados falhou (${err instanceof Error ? err.name : 'erro desconhecido'})`,
      );
    }
  }

  /**
   * Apaga as linhas com `expiresAt` anterior a agora e devolve as contagens.
   * Público para os testes e para uma execução manual.
   */
  async purgeExpired(): Promise<PurgeExpiredResult> {
    const now = new Date();
    const [refreshTokens, exchangeCodes] = await this.prisma.$transaction([
      this.prisma.refreshToken.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
      this.prisma.oAuthExchangeCode.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
    ]);
    const result = {
      refreshTokens: refreshTokens.count,
      exchangeCodes: exchangeCodes.count,
    };
    // Só contagens: nenhum id, userId ou hash.
    this.logger.log(
      `Tokens expirados apagados: refreshTokens=${result.refreshTokens} exchangeCodes=${result.exchangeCodes}`,
    );
    return result;
  }
}
