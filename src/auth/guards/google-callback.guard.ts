import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import {
  GoogleCallbackError,
  GoogleEmailNotVerifiedException,
  type GoogleCallbackErrorCode,
} from '../google-callback.js';
import { OAUTH_STATE_MISMATCH, OAuthStateStore } from '../oauth-state.store.js';

/**
 * Aplica a GoogleStrategy no callback do Google. Não deixa nenhuma falha sair
 * como 401/500: classifica cada uma num código fixo e lança GoogleCallbackError,
 * que o GoogleCallbackFilter converte em redirect para o frontend (A-13).
 */
@Injectable()
export class GoogleCallbackGuard extends AuthGuard('google') {
  constructor(private readonly stateStore: OAuthStateStore) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();

    // O cookie de state é de uso único: apagá-lo já na entrada cobre todos os
    // desfechos, porque o Set-Cookie segue no redirect de sucesso ou de erro.
    // A leitura no `verify` usa o cookie da request, que isto não afeta.
    this.stateStore.clear(http.getResponse<Response>());

    // Sem `code` nem `error`, o passport trataria o callback como início de
    // fluxo (novo state, redirect para o Google).
    if (req.query['code'] === undefined && req.query['error'] === undefined) {
      throw new GoogleCallbackError('oauth_failed');
    }
    return super.canActivate(context);
  }

  override handleRequest<TUser>(
    err: unknown,
    user: TUser | false,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (!err && user) return user;
    const req = context.switchToHttp().getRequest<Request>();
    throw new GoogleCallbackError(
      failureCode(err, info, req.query['error']),
      err ?? undefined,
    );
  }
}

/**
 * - `?error=access_denied`: o passport-oauth2 chama `fail()` antes de olhar o
 *   state, com a error_description do Google no `info` (descartada aqui);
 * - outro `?error=`: `error()` com AuthorizationError -> oauth_failed;
 * - `fail()` com o `info` do OAuthStateStore: state recusado;
 * - erro do `validate()` por email não verificado;
 * - qualquer outro erro (TokenError do `code` inválido etc.): oauth_failed.
 */
function failureCode(
  err: unknown,
  info: unknown,
  providerError: unknown,
): GoogleCallbackErrorCode {
  if (providerError === 'access_denied') return 'access_denied';
  if (err instanceof GoogleEmailNotVerifiedException) {
    return 'email_not_verified';
  }
  if (!err && info === OAUTH_STATE_MISMATCH) return 'state_mismatch';
  return 'oauth_failed';
}
