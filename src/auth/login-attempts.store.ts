import { OnModuleDestroy } from '@nestjs/common';

/** Janela de tentativas de uma chave. */
export interface LoginAttemptsWindow {
  /** Tentativas contadas na janela (inclui a que acabou de ser somada). */
  attempts: number;
  /** Fim da janela, em epoch ms. */
  expiresAt: number;
}

/**
 * Onde ficam as contagens do limite de login por conta (A-03). Também é o
 * token de injeção: trocar o storage é registrar outra implementação no
 * AuthModule.
 *
 * Pensada para mapear direto em Redis: `increment` = `INCR` + `PEXPIRE NX` +
 * `PTTL` (num MULTI ou script Lua), `reset` = `DEL`. As chaves já chegam como
 * hash; o store nunca vê o email.
 */
export abstract class LoginAttemptsStore {
  /**
   * Soma uma tentativa à chave e devolve a janela. Sem janela aberta, abre uma
   * nova de `windowMs` a partir de agora; com janela aberta, NÃO a estende.
   */
  abstract increment(
    key: string,
    windowMs: number,
  ): Promise<LoginAttemptsWindow>;

  /** Esquece a chave (login bem-sucedido). */
  abstract reset(key: string): Promise<void>;
}

/** Teto de chaves em memória (cada uma ocupa por volta de 200 bytes). */
export const LOGIN_ATTEMPTS_MAX_ENTRIES = 50_000;

/** De quanto em quanto tempo as janelas expiradas são removidas. */
export const LOGIN_ATTEMPTS_SWEEP_INTERVAL_MS = 60_000;

/**
 * Implementação em memória: por processo, zera no restart e não é
 * compartilhada entre instâncias (para mais de uma instância, use Redis).
 *
 * Não cresce sem limite: as janelas expiradas saem numa varredura periódica
 * (e ao serem lidas), e com o mapa cheio a janela mais antiga é descartada.
 * Como toda janela tem a mesma duração e é inserida quando começa, a ordem de
 * inserção do Map é a ordem de expiração: a descartada é a que acabaria
 * primeiro.
 */
export class InMemoryLoginAttemptsStore
  extends LoginAttemptsStore
  implements OnModuleDestroy
{
  private readonly windows = new Map<string, LoginAttemptsWindow>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly maxEntries = LOGIN_ATTEMPTS_MAX_ENTRIES,
    sweepIntervalMs = LOGIN_ATTEMPTS_SWEEP_INTERVAL_MS,
  ) {
    super();
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    // Não segura o processo vivo só por causa da varredura.
    this.sweepTimer.unref();
  }

  increment(key: string, windowMs: number): Promise<LoginAttemptsWindow> {
    const now = Date.now();
    const current = this.windows.get(key);
    if (current && current.expiresAt > now) {
      current.attempts += 1;
      return Promise.resolve({ ...current });
    }

    // Janela nova vai para o fim do Map (mantém a ordem de expiração).
    this.windows.delete(key);
    this.makeRoom(now);
    const window = { attempts: 1, expiresAt: now + windowMs };
    this.windows.set(key, window);
    return Promise.resolve({ ...window });
  }

  reset(key: string): Promise<void> {
    this.windows.delete(key);
    return Promise.resolve();
  }

  /** Quantas chaves estão guardadas (inclusive expiradas ainda não varridas). */
  get size(): number {
    return this.windows.size;
  }

  /** Remove as janelas expiradas. */
  sweep(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) this.windows.delete(key);
    }
  }

  /** Esvazia o store (usado entre testes e2e). */
  clear(): void {
    this.windows.clear();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxEntries) return;
    this.sweep(now);
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxEntries) break;
      this.windows.delete(key);
    }
  }
}
