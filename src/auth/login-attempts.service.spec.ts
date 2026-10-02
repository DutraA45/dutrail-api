import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerException } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { EnvironmentVariables } from '../config/env.validation.js';
import {
  AccountLoginLimitException,
  LoginAttemptsService,
} from './login-attempts.service.js';
import {
  InMemoryLoginAttemptsStore,
  LOGIN_ATTEMPTS_SWEEP_INTERVAL_MS,
} from './login-attempts.store.js';

const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;
const WINDOW_MS = WINDOW_MINUTES * 60_000;
const EMAIL = 'ana@example.com';

function configWith(values: Partial<EnvironmentVariables>) {
  return {
    get: (name: keyof EnvironmentVariables) => values[name],
  } as unknown as ConfigService<EnvironmentVariables, true>;
}

describe('LoginAttemptsService + InMemoryLoginAttemptsStore', () => {
  let store: InMemoryLoginAttemptsStore;
  let service: LoginAttemptsService;

  /** Uma tentativa; devolve o 429 se houve, ou undefined. */
  async function attempt(
    email = EMAIL,
  ): Promise<AccountLoginLimitException | undefined> {
    try {
      await service.consume(email);
      return undefined;
    } catch (err) {
      expect(err).toBeInstanceOf(AccountLoginLimitException);
      return err as AccountLoginLimitException;
    }
  }

  async function fail(times: number, email = EMAIL): Promise<void> {
    for (let i = 0; i < times; i++) {
      expect(await attempt(email), `tentativa ${i + 1}`).toBeUndefined();
    }
  }

  beforeEach(() => {
    // Antes de criar o store: o setInterval da varredura também é falso.
    vi.useFakeTimers();
    store = new InMemoryLoginAttemptsStore();
    service = new LoginAttemptsService(
      store,
      configWith({
        LOGIN_MAX_FAILURES: MAX_FAILURES,
        LOGIN_FAILURE_WINDOW_MINUTES: WINDOW_MINUTES,
      }),
    );
  });

  afterEach(() => {
    store.onModuleDestroy();
    vi.useRealTimers();
  });

  describe('contagem', () => {
    it(`libera ${MAX_FAILURES} tentativas e recusa a seguinte com o 429 do throttler`, async () => {
      await fail(MAX_FAILURES);

      const limited = await attempt();
      expect(limited).toBeInstanceOf(ThrottlerException);
      expect(limited!.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      // Mesma mensagem do 429 por IP.
      expect(limited!.message).toBe(new ThrottlerException().message);
      expect(limited!.retryAfterSeconds).toBe(WINDOW_MS / 1000);
    });

    it('continua recusando enquanto a janela durar', async () => {
      await fail(MAX_FAILURES);
      for (let i = 0; i < 20; i++) {
        expect(await attempt()).toBeDefined();
      }
    });

    it('cada email tem o seu contador', async () => {
      await fail(MAX_FAILURES);
      expect(await attempt()).toBeDefined();

      await fail(MAX_FAILURES, 'bruno@example.com');
    });

    it('normaliza o email como os DTOs (trim e minúsculas)', async () => {
      await fail(MAX_FAILURES, '  ANA@Example.COM ');
      expect(await attempt(EMAIL)).toBeDefined();
    });
  });

  describe('janela', () => {
    it('as tentativas recusadas não estendem a janela, que acaba no prazo', async () => {
      await fail(MAX_FAILURES);

      vi.advanceTimersByTime(WINDOW_MS - 1_000);
      const limited = await attempt();
      expect(limited!.retryAfterSeconds).toBe(1);

      vi.advanceTimersByTime(1_000);
      // Janela nova: de novo MAX_FAILURES tentativas.
      await fail(MAX_FAILURES);
      expect(await attempt()).toBeDefined();
    });

    it('falhas espaçadas mais que a janela nunca bloqueiam', async () => {
      for (let i = 0; i < MAX_FAILURES * 3; i++) {
        await fail(1);
        vi.advanceTimersByTime(WINDOW_MS);
      }
    });

    it('a janela começa na primeira falha (não desliza)', async () => {
      await fail(1);
      vi.advanceTimersByTime(WINDOW_MS - 1);
      await fail(MAX_FAILURES - 1);
      vi.advanceTimersByTime(1);
      // A primeira janela acabou; estas contam numa nova.
      await fail(MAX_FAILURES);
      expect(await attempt()).toBeDefined();
    });
  });

  describe('reset no sucesso', () => {
    it('um login certo antes do limite zera o contador', async () => {
      await fail(MAX_FAILURES - 1);
      await service.succeeded(EMAIL);

      await fail(MAX_FAILURES);
      expect(await attempt()).toBeDefined();
    });

    it('zera só o email do login certo', async () => {
      await fail(MAX_FAILURES - 1);
      await fail(MAX_FAILURES - 1, 'bruno@example.com');
      await service.succeeded('bruno@example.com');

      await fail(1);
      expect(await attempt()).toBeDefined();
      await fail(MAX_FAILURES, 'bruno@example.com');
    });
  });

  describe('expiração e limite de entradas', () => {
    it('a varredura periódica remove as janelas expiradas', async () => {
      await fail(1, 'a@example.com');
      await fail(1, 'b@example.com');
      expect(store.size).toBe(2);

      vi.advanceTimersByTime(WINDOW_MS - LOGIN_ATTEMPTS_SWEEP_INTERVAL_MS);
      expect(store.size).toBe(2);

      // A primeira varredura depois do fim da janela as remove.
      vi.advanceTimersByTime(LOGIN_ATTEMPTS_SWEEP_INTERVAL_MS);
      expect(store.size).toBe(0);
    });

    it('o encerramento do módulo para a varredura', () => {
      expect(vi.getTimerCount()).toBe(1);
      store.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('com o mapa cheio, descarta primeiro as expiradas e depois a mais antiga', async () => {
      const small = new InMemoryLoginAttemptsStore(3);
      try {
        await small.increment('k1', 1_000);
        await small.increment('k2', WINDOW_MS);
        await small.increment('k3', WINDOW_MS);
        vi.advanceTimersByTime(1_000); // k1 expira, sem varredura ainda

        await small.increment('k4', WINDOW_MS);
        expect(small.size).toBe(3);
        // k1 (expirada) saiu; k2 continua contando.
        expect((await small.increment('k2', WINDOW_MS)).attempts).toBe(2);

        await small.increment('k5', WINDOW_MS);
        expect(small.size).toBe(3);
        // Nenhuma expirada: saiu a mais antiga (k2), e ela recomeça do zero.
        expect((await small.increment('k3', WINDOW_MS)).attempts).toBe(2);
        expect((await small.increment('k4', WINDOW_MS)).attempts).toBe(2);
        expect((await small.increment('k5', WINDOW_MS)).attempts).toBe(2);
        expect(small.size).toBe(3);
      } finally {
        small.onModuleDestroy();
      }
    });

    it('nunca passa do teto, mesmo com muitos emails diferentes', async () => {
      const small = new InMemoryLoginAttemptsStore(100);
      try {
        for (let i = 0; i < 1_000; i++) {
          await small.increment(`k${i}`, WINDOW_MS);
          expect(small.size).toBeLessThanOrEqual(100);
        }
      } finally {
        small.onModuleDestroy();
      }
    });
  });

  describe('chave', () => {
    it('é o SHA-256 do email normalizado e não contém o email', async () => {
      const increment = vi.spyOn(store, 'increment');
      const reset = vi.spyOn(store, 'reset');

      await service.consume(' Ana@Example.com');
      await service.succeeded('ANA@example.com ');

      const expected = createHash('sha256').update(EMAIL).digest('hex');
      const keys = [increment.mock.calls[0][0], reset.mock.calls[0][0]];
      for (const key of keys) {
        expect(key).toBe(expected);
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(key.toLowerCase()).not.toContain('ana');
        expect(key).not.toContain('example');
        expect(key).not.toContain('@');
      }
      expect(LoginAttemptsService.keyFor(EMAIL)).toBe(expected);
    });
  });
});
