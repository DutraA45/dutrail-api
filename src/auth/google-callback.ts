import { UnauthorizedException } from '@nestjs/common';

/**
 * Rota do callback do Google. Precisa casar com o @Controller('auth') +
 * @Get('google/callback') do AuthController (o teste do aviso de configuração
 * confere) e com o caminho do GOOGLE_CALLBACK_URL.
 */
export const GOOGLE_CALLBACK_PATH = '/auth/google/callback';

/**
 * Códigos do `?error=` com que o callback redireciona ao frontend (A-13).
 * Fixos: nada que o Google manda (error_description etc.) é repassado.
 *
 * - access_denied:      o usuário cancelou a tela de consentimento;
 * - email_not_verified: o Google não garante o email (regra do loginWithGoogle);
 * - state_mismatch:     cookie de state ausente, expirado, adulterado ou
 *                       `state` divergente (A-02);
 * - oauth_failed:       qualquer outra falha (`code` inválido, outro `error=`
 *                       do Google, erro inesperado).
 */
export const GOOGLE_CALLBACK_ERROR_CODES = [
  'access_denied',
  'email_not_verified',
  'state_mismatch',
  'oauth_failed',
] as const;

export type GoogleCallbackErrorCode =
  (typeof GOOGLE_CALLBACK_ERROR_CODES)[number];

/**
 * Falha do callback, já classificada. Lançada pelo GoogleCallbackGuard (e pelo
 * handler) e convertida em redirect pelo GoogleCallbackFilter. `cause` é o erro
 * original, que nunca vai para o cliente.
 */
export class GoogleCallbackError extends Error {
  constructor(
    readonly code: GoogleCallbackErrorCode,
    cause?: unknown,
  ) {
    super(`Google callback failed: ${code}`, { cause });
    this.name = 'GoogleCallbackError';
  }
}

/**
 * O Google não garante que o email é da pessoa (ver AuthService.loginWithGoogle).
 * Subclasse do 401 de antes, só para o guard reconhecer o caso sem depender da
 * mensagem.
 */
export class GoogleEmailNotVerifiedException extends UnauthorizedException {
  constructor() {
    super('Google account email is not verified');
  }
}

/** `${FRONTEND_URL}/auth/callback?code=...` ou `?error=...`. */
export function frontendCallbackUrl(
  frontendUrl: string,
  params: { code: string } | { error: GoogleCallbackErrorCode },
): string {
  return `${frontendUrl}/auth/callback?${new URLSearchParams(params).toString()}`;
}
