import { Injectable } from '@nestjs/common';
import type { BreachCheckResult } from '../../src/auth/breached-password.service.js';
import { PasswordService } from '../../src/auth/password.service.js';

/**
 * Estado da "lista de vazadas" falsa. Os testes cadastram senhas vazadas ou
 * forçam uma indisponibilidade; o padrão é "nenhuma vazada", sem rede.
 */
export const fakeBreachedPasswords = {
  breached: new Set<string>(),
  outcome: undefined as 'timeout' | 'error' | undefined,
  checked: [] as string[],
  reset() {
    this.breached = new Set();
    this.outcome = undefined;
    this.checked = [];
  },
};

/**
 * Substitui o BreachedPasswordService nos e2e: nenhum teste vai à API do Have
 * I Been Pwned. Compara a forma NFKC, como o real (que consulta o SHA-1 dela).
 */
@Injectable()
export class FakeBreachedPasswordService {
  check(password: string): Promise<BreachCheckResult> {
    fakeBreachedPasswords.checked.push(password);
    if (fakeBreachedPasswords.outcome) {
      return Promise.resolve(fakeBreachedPasswords.outcome);
    }
    const normalized = PasswordService.normalize(password);
    const listed = [...fakeBreachedPasswords.breached].some(
      (p) => PasswordService.normalize(p) === normalized,
    );
    return Promise.resolve(listed ? 'breached' : 'clean');
  }
}
