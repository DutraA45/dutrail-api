import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Prisma, type Activity } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  decodeActivityCursor,
  encodeActivityCursor,
} from './activity-cursor.js';
import { parseFitActivity } from './fit/fit-activity-parser.js';
import { ActivityFileStorageService } from './storage/activity-file-storage.service.js';

export const DUPLICATE_IMPORT_MESSAGE = 'Esta atividade já foi importada.';

export interface ActivityPage {
  items: Activity[];
  nextCursor: string | null;
}

/**
 * Leitura e importação de atividades. Toda consulta recebe o `userId` do token
 * e filtra por ele no próprio WHERE: não existe método que busque atividade só
 * pelo id.
 */
@Injectable()
export class ActivitiesService {
  private readonly logger = new Logger(ActivitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ActivityFileStorageService,
  ) {}

  /**
   * Mais recentes primeiro. `id` desempata atividades com o mesmo `startedAt`,
   * o que torna a ordem total — requisito para o cursor não pular nem repetir
   * itens entre páginas.
   */
  async listForUser(
    userId: string,
    options: { limit: number; cursor?: string },
  ): Promise<ActivityPage> {
    const after =
      options.cursor === undefined
        ? undefined
        : decodeActivityCursor(options.cursor);

    // Busca um item a mais só para saber se existe próxima página.
    const rows = await this.prisma.activity.findMany({
      where: {
        userId,
        ...(after && {
          OR: [
            { startedAt: { lt: after.startedAt } },
            { startedAt: after.startedAt, id: { lt: after.id } },
          ],
        }),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
    });

    const hasMore = rows.length > options.limit;
    const items = hasMore ? rows.slice(0, options.limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeActivityCursor(last) : null,
    };
  }

  /** `null` tanto para id inexistente quanto para atividade de outro usuário. */
  findForUser(userId: string, id: string): Promise<Activity | null> {
    return this.prisma.activity.findFirst({ where: { id, userId } });
  }

  /**
   * Cria uma atividade a partir de um arquivo .fit e guarda o original no
   * storage.
   *
   * Ordem: validar tudo o que é barato (parse, duplicidade) antes de tocar no
   * storage; depois upload e só então o INSERT. Banco e bucket não participam
   * da mesma transação, então a consistência vem da ordem + compensação:
   * - upload falhou → nada foi gravado no banco (500);
   * - INSERT falhou → o objeto recém-enviado é apagado. Se até a remoção
   *   falhar, a chave vai para o log para limpeza manual.
   * Nunca fica atividade apontando para um arquivo inexistente.
   */
  async importFitFile(userId: string, file: Uint8Array): Promise<Activity> {
    const { data, fingerprint } = parseFitActivity(file);

    // O índice único (userId, fitFingerprint) é a garantia real; esta consulta
    // só evita subir para o bucket um arquivo que seria recusado.
    const duplicate = await this.prisma.activity.findFirst({
      where: { userId, fitFingerprint: fingerprint },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(DUPLICATE_IMPORT_MESSAGE);
    }

    // O id é gerado aqui (e não pelo banco) para entrar na chave do objeto:
    // o arquivo no bucket leva ao usuário e à atividade.
    const id = randomUUID();
    const fitFileKey = ActivityFileStorageService.keyFor(userId, id);

    try {
      await this.storage.put(fitFileKey, file);
    } catch (error) {
      this.logger.error(
        `Upload do .fit para o storage falhou (key=${fitFileKey})`,
        error instanceof Error ? error.stack : String(error),
      );
      // Sem detalhe de infraestrutura para o cliente.
      throw new InternalServerErrorException('Internal server error');
    }

    try {
      return await this.prisma.activity.create({
        data: {
          id,
          userId,
          ...data,
          fitFileKey,
          fitFingerprint: fingerprint,
        },
      });
    } catch (error) {
      await this.deleteOrphanFile(fitFileKey);
      // Duas importações simultâneas do mesmo arquivo: as duas passam pela
      // checagem acima, e o índice único barra a segunda.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(DUPLICATE_IMPORT_MESSAGE);
      }
      throw error;
    }
  }

  private async deleteOrphanFile(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.error(
        `Arquivo órfão no storage, remover manualmente (key=${key})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
