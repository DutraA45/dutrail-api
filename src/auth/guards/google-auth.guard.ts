import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Aplica a GoogleStrategy. Existe como classe (em vez de usar
 * `@UseGuards(AuthGuard('google'))` direto) para o e2e poder referenciá-la e
 * para ser o ponto único de configuração caso precisemos de opções extras
 * (ex.: `prompt: 'select_account'`).
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}
