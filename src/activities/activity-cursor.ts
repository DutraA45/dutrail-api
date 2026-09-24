import { BadRequestException } from '@nestjs/common';

/** Posição na listagem: a última atividade entregue na página anterior. */
export interface ActivityCursor {
  startedAt: Date;
  id: string;
}

/**
 * Cursor opaco para o cliente: base64url de `[startedAt ISO, id]`.
 *
 * Carrega a posição inteira (em vez de só o id) por dois motivos:
 * - não depende da atividade ainda existir — apagar o último item da página
 *   não quebra a próxima;
 * - não consulta a linha do cursor, então um id de atividade de outro usuário
 *   não revela nada (é só uma posição na ordenação do próprio usuário).
 */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.startedAt.toISOString(), cursor.id]),
  ).toString('base64url');
}

/** Lança 400 para qualquer cursor que não tenha saído de `encodeActivityCursor`. */
export function decodeActivityCursor(raw: string): ActivityCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      parsed[1].length > 0
    ) {
      const startedAt = new Date(parsed[0]);
      if (!Number.isNaN(startedAt.getTime())) {
        return { startedAt, id: parsed[1] };
      }
    }
  } catch {
    // JSON inválido: cai no 400 abaixo.
  }
  throw new BadRequestException('Invalid cursor');
}
