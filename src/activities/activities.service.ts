import { Injectable } from '@nestjs/common';
import type { Activity } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  decodeActivityCursor,
  encodeActivityCursor,
} from './activity-cursor.js';

export interface ActivityPage {
  items: Activity[];
  nextCursor: string | null;
}

/**
 * Leitura de atividades. Toda consulta recebe o `userId` do token e filtra por
 * ele no próprio WHERE: não existe método que busque atividade só pelo id.
 */
@Injectable()
export class ActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

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
}
