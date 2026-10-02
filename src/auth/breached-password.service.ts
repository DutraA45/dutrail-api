import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EnvironmentVariables } from '../config/env.validation.js';
import { PasswordService } from './password.service.js';

/** Range API do Have I Been Pwned (Pwned Passwords): pública, sem chave. */
export const PWNED_PASSWORDS_RANGE_URL =
  'https://api.pwnedpasswords.com/range/';

/**
 * `breached`/`clean`: a consulta respondeu. `timeout`/`error`: não deu para
 * saber (rede, 5xx, resposta inesperada). `disabled`: checagem desligada.
 */
export type BreachCheckResult =
  'breached' | 'clean' | 'timeout' | 'error' | 'disabled';

/**
 * Checagem de senha vazada (A-09, ASVS 2.1.7) por k-anonymity: só os 5
 * primeiros caracteres hex do SHA-1 saem daqui; a API devolve todos os
 * sufixos com esse prefixo (centenas) e a comparação é local. Com
 * `Add-Padding`, a resposta ganha sufixos falsos (contagem 0), para que nem
 * o tamanho dela revele algo sobre o prefixo.
 *
 * O SHA-1 é da forma NFKC, a mesma que vai para o argon2.
 */
@Injectable()
export class BreachedPasswordService {
  private readonly enabled: boolean;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.enabled = config.get('BREACHED_PASSWORD_CHECK', { infer: true });
    this.timeoutMs = config.get('BREACHED_PASSWORD_TIMEOUT_MS', {
      infer: true,
    });
  }

  /** Nunca lança: quem chama decide o que fazer quando não deu para saber. */
  async check(password: string): Promise<BreachCheckResult> {
    if (!this.enabled) return 'disabled';

    const sha1 = createHash('sha1')
      .update(PasswordService.normalize(password), 'utf8')
      .digest('hex')
      .toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      // O timeout vale para a resposta inteira, corpo incluído.
      const res = await fetch(`${PWNED_PASSWORDS_RANGE_URL}${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'dutrail-api' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return 'error';
      return BreachedPasswordService.isListed(await res.text(), suffix)
        ? 'breached'
        : 'clean';
    } catch (err) {
      return err instanceof Error && err.name === 'TimeoutError'
        ? 'timeout'
        : 'error';
    }
  }

  /** Linhas `SUFIXO:CONTAGEM`; as do padding têm contagem 0 e não contam. */
  private static isListed(body: string, suffix: string): boolean {
    return body.split('\n').some((line) => {
      const [candidate, count] = line.trim().split(':');
      return candidate === suffix && Number(count) > 0;
    });
  }
}
