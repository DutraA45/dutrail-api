import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { EnvironmentVariables } from '../../config/env.validation.js';
import { securityContextFrom } from '../../security/security-context.js';
import {
  SecurityLogService,
  type SecurityReason,
} from '../../security/security-log.service.js';
import {
  frontendCallbackUrl,
  GoogleCallbackError,
  type GoogleCallbackErrorCode,
} from '../google-callback.js';

/** Motivo no log de segurança para cada código do redirect. */
const SECURITY_REASON: Record<GoogleCallbackErrorCode, SecurityReason> = {
  access_denied: 'access_denied',
  email_not_verified: 'email_not_verified',
  state_mismatch: 'state_mismatch',
  oauth_failed: 'callback_error',
};

/**
 * Erros que o passport-oauth2 e o passport-google-oauth20 produzem quando o
 * Google recusa ou falha (`code` inválido, `error=` no callback, perfil
 * indisponível). Desfechos esperados do fluxo: sem stack no log.
 */
const OAUTH_ERROR_NAMES = new Set([
  'TokenError',
  'AuthorizationError',
  'InternalOAuthError',
  'UserInfoError',
  'GooglePlusAPIError',
]);

/**
 * Só no GET /auth/google/callback (via @UseFilters). Toda falha do callback
 * vira 302 para `${FRONTEND_URL}/auth/callback?error=<código>` (A-13), em vez
 * de JSON no domínio da API, e um `google_exchange_failed` no log de segurança.
 *
 * Pega só GoogleCallbackError: o resto (ex.: o 429 do throttler, que roda antes
 * do guard) segue para o AllExceptionsFilter como em qualquer rota.
 */
@Catch(GoogleCallbackError)
export class GoogleCallbackFilter implements ExceptionFilter {
  private readonly logger = new Logger(GoogleCallbackFilter.name);

  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly securityLog: SecurityLogService,
  ) {}

  catch(exception: GoogleCallbackError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    this.securityLog.warn(
      'google_exchange_failed',
      securityContextFrom(request),
      { reason: SECURITY_REASON[exception.code] },
    );

    if (isUnexpected(exception.cause)) {
      // Defeito nosso (banco fora, bug), não do OAuth: o stack ainda interessa.
      // `path`, não `url`: a query traz `code` e `state` (A-19).
      this.logger.error(
        `${request.method} ${request.path} -> ${exception.code}`,
        exception.cause instanceof Error
          ? exception.cause.stack
          : String(exception.cause),
      );
    }

    response.redirect(
      HttpStatus.FOUND,
      frontendCallbackUrl(this.config.get('FRONTEND_URL', { infer: true }), {
        error: exception.code,
      }),
    );
  }
}

function isUnexpected(cause: unknown): boolean {
  if (cause === undefined) return false;
  if (cause instanceof HttpException) {
    return cause.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR;
  }
  return !(cause instanceof Error && OAUTH_ERROR_NAMES.has(cause.name));
}
