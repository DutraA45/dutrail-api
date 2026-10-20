import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface.js';
import { AccountLoginLimitException } from '../../auth/login-attempts.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  declaredClientType,
  securityContextFrom,
} from '../../security/security-context.js';
import { SecurityLogService } from '../../security/security-log.service.js';
import { ErrorResponseDto } from '../dto/error-response.dto.js';

/**
 * Filtro global: converte QUALQUER exceção no formato padrão ErrorResponseDto.
 *
 * - HttpException (e subclasses do Nest): mantém status e mensagem.
 * - Erros conhecidos do Prisma: traduz os casos úteis (P2002 = unique).
 * - Qualquer outra coisa: 500 genérico. A mensagem original vai só para o
 *   log, nunca para o cliente (poderia vazar detalhes internos).
 *
 * Também é o ponto que enxerga o 429 do ThrottlerGuard (que roda antes de
 * qualquer service), por isso registra o `rate_limited`, junto com o 429 do
 * limite de login por conta (lançado pelo AuthService). As falhas do callback
 * do Google não chegam aqui: o GoogleCallbackFilter as converte em redirect.
 */
/**
 * Caminho completo da request, sem a query string. Os handlers de 404 e de
 * erro do Nest ficam montados sob o prefixo global (`app.use('/api', ...)`), e
 * ali o Express tira o prefixo de `req.path` e o guarda em `req.baseUrl`; nas
 * rotas comuns, `baseUrl` é vazio.
 */
function pathWithoutQuery(request: Request): string {
  return `${request.baseUrl}${request.path}`;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly securityLog: SecurityLogService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const httpException = this.toHttpException(exception);
    const status = httpException.getStatus();

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Sem a query string: ela pode trazer credenciais (o `code` e o `state`
      // do /api/auth/google/callback) e não deve chegar ao log.
      this.logger.error(
        `${request.method} ${pathWithoutQuery(request)} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    this.recordSecurityEvent(request, status, exception);

    // O 429 do limite por conta sai igual ao do throttler por IP, que manda o
    // Retry-After (em segundos) antes de lançar.
    if (exception instanceof AccountLoginLimitException) {
      response.header('Retry-After', String(exception.retryAfterSeconds));
    }

    const body: ErrorResponseDto = {
      statusCode: status,
      error: this.extractError(httpException),
      message: this.extractMessage(httpException),
      // `originalUrl`, não `url`: nos handlers montados sob o prefixo (404 de
      // rota inexistente, JSON malformado) o `url` vem sem o /api.
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }

  private recordSecurityEvent(
    request: Request,
    status: number,
    exception: unknown,
  ): void {
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      const user = request.user as AuthenticatedUser | undefined;
      this.securityLog.warn(
        'rate_limited',
        securityContextFrom(request, declaredClientType(request)),
        {
          userId: user?.userId,
          // Sem query string (mesmo motivo do log de erro acima).
          path: pathWithoutQuery(request),
          reason:
            exception instanceof AccountLoginLimitException
              ? 'account_login_limit'
              : undefined,
        },
      );
    }
  }

  private toHttpException(exception: unknown): HttpException {
    if (exception instanceof HttpException) {
      return exception;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002: violação de constraint única (ex.: email já cadastrado).
      if (exception.code === 'P2002') {
        return new ConflictException('Resource already exists');
      }
      // P2025: registro não encontrado em update/delete.
      if (exception.code === 'P2025') {
        return new HttpException('Resource not found', HttpStatus.NOT_FOUND);
      }
    }

    return new InternalServerErrorException('Internal server error');
  }

  // As respostas do Nest podem ser string ou { message, error, statusCode }.
  private extractMessage(exception: HttpException): string | string[] {
    const res = exception.getResponse();
    if (typeof res === 'string') return res;
    const message = (res as { message?: string | string[] }).message;
    return message ?? exception.message;
  }

  private extractError(exception: HttpException): string {
    const res = exception.getResponse();
    if (typeof res === 'object' && res !== null && 'error' in res) {
      return String((res as { error: unknown }).error);
    }
    // Fallback: nome legível do status ("Unauthorized", "Conflict", ...).
    return HttpStatus[exception.getStatus()]
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
