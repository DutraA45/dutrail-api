import {
  applyDecorators,
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';

/** Header obrigatório nas rotas que entregam ou leem o refresh token. */
export const CLIENT_TYPE_HEADER = 'x-client-type';

/**
 * Tipo de cliente que fez a request. Define **apenas** o transporte do refresh
 * token (cookie httpOnly para web, corpo JSON para mobile); a lógica de
 * rotação/revogação é idêntica para os dois.
 */
export type ClientType = 'web' | 'mobile';

export const CLIENT_TYPES: readonly ClientType[] = ['web', 'mobile'];

/**
 * Valida o header e devolve o tipo. Sem default silencioso: header ausente ou
 * com valor desconhecido é erro do cliente (400), porque escolher um default
 * entregaria o refresh token pelo canal errado.
 */
export function parseClientType(raw: unknown): ClientType {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BadRequestException(
      `${CLIENT_TYPE_HEADER} header is required (expected one of: ${CLIENT_TYPES.join(', ')})`,
    );
  }

  const value = raw.trim().toLowerCase();
  if (!CLIENT_TYPES.includes(value as ClientType)) {
    throw new BadRequestException(
      `${CLIENT_TYPE_HEADER} header must be one of: ${CLIENT_TYPES.join(', ')}`,
    );
  }

  return value as ClientType;
}

/**
 * Injeta o tipo de cliente no handler: `@ClientType() clientType: ClientType`.
 *
 * O decorator é a própria validação — só existe tipo de cliente onde a rota
 * declara este parâmetro, então não há rota lendo o header "por engano".
 *
 * (O `type` acima e este `const` compartilham o nome de propósito: TypeScript
 * mantém tipos e valores em espaços separados, então um único import serve
 * para anotar e para decorar.)
 */
export const ClientType = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientType => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return parseClientType(request.headers[CLIENT_TYPE_HEADER]);
  },
);

/** Documenta o header no Swagger (inclui o campo na UI do "Try it out"). */
export const ApiClientTypeHeader = () =>
  applyDecorators(
    ApiHeader({
      name: 'X-Client-Type',
      required: true,
      description:
        'Define o transporte do refresh token: `web` usa cookie httpOnly, `mobile` usa o corpo JSON. ' +
        'Ausente ou inválido retorna 400.',
      schema: { type: 'string', enum: [...CLIENT_TYPES], example: 'web' },
    }),
  );
