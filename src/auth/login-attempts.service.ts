import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerException } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { EnvironmentVariables } from '../config/env.validation.js';
import { LoginAttemptsStore } from './login-attempts.store.js';

/**
 * 429 do limite por conta. É um ThrottlerException (mesmo status e mesma
 * mensagem do rate limit por IP), para o cliente não distinguir os dois nem,
 * por eles, saber se a conta existe. O AllExceptionsFilter o reconhece para
 * mandar o `Retry-After` (como o throttler) e o `reason` do log.
 */
export class AccountLoginLimitException extends ThrottlerException {
  constructor(readonly retryAfterSeconds: number) {
    super();
  }
}

/**
 * Limite de falhas de login por conta (A-03), contra força bruta e
 * credential stuffing distribuídos em muitos IPs, que o limite por IP não
 * pega.
 *
 * A chave é o SHA-256 do email normalizado, aplicada SEMPRE, exista ou não a
 * conta: o comportamento (e a resposta 429) é o mesmo nos dois casos. O email
 * em si nunca é guardado.
 *
 * A tentativa é contada ANTES de conferir a senha, e o sucesso zera a
 * contagem; uma falha simplesmente a mantém. Contar antes impede que várias
 * requests simultâneas passem pela checagem antes de qualquer falha ser
 * registrada. Passando de LOGIN_MAX_FAILURES na janela, toda tentativa recebe
 * 429, mesmo com a senha certa, até a janela (que não é estendida) acabar.
 */
@Injectable()
export class LoginAttemptsService {
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(
    private readonly store: LoginAttemptsStore,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxFailures = config.get('LOGIN_MAX_FAILURES', { infer: true });
    this.windowMs =
      config.get('LOGIN_FAILURE_WINDOW_MINUTES', { infer: true }) * 60_000;
  }

  /** SHA-256 (hex) do email normalizado como nos DTOs (trim + minúsculas). */
  static keyFor(email: string): string {
    return createHash('sha256')
      .update(email.trim().toLowerCase())
      .digest('hex');
  }

  /**
   * Conta uma tentativa para o email. Lança AccountLoginLimitException se o
   * limite da janela já tinha sido atingido.
   */
  async consume(email: string): Promise<void> {
    const { attempts, expiresAt } = await this.store.increment(
      LoginAttemptsService.keyFor(email),
      this.windowMs,
    );
    if (attempts > this.maxFailures) {
      const seconds = Math.ceil((expiresAt - Date.now()) / 1000);
      throw new AccountLoginLimitException(Math.max(1, seconds));
    }
  }

  /** Login bem-sucedido: zera a contagem do email. */
  succeeded(email: string): Promise<void> {
    return this.store.reset(LoginAttemptsService.keyFor(email));
  }
}
