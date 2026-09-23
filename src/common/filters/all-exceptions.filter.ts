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
import { Prisma } from '../../generated/prisma/client.js';
import { ErrorResponseDto } from '../dto/error-response.dto.js';

/**
 * Filtro global: converte QUALQUER exceção no formato padrão ErrorResponseDto.
 *
 * - HttpException (e subclasses do Nest): mantém status e mensagem.
 * - Erros conhecidos do Prisma: traduz os casos úteis (P2002 = unique).
 * - Qualquer outra coisa: 500 genérico. A mensagem original vai só para o
 *   log, nunca para o cliente (poderia vazar detalhes internos).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const httpException = this.toHttpException(exception);
    const status = httpException.getStatus();

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponseDto = {
      statusCode: status,
      error: this.extractError(httpException),
      message: this.extractMessage(httpException),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
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
