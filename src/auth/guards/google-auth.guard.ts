import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Aplica a GoogleStrategy no início do fluxo (GET /auth/google): a strategy
 * grava o state + code_verifier no cookie (OAuthStateStore) e redireciona para
 * o Google. O callback usa o GoogleCallbackGuard.
 *
 * Existe como classe (em vez de usar `@UseGuards(AuthGuard('google'))` direto)
 * para ser o ponto único de configuração caso precisemos de opções extras
 * (ex.: `prompt: 'select_account'`).
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}
