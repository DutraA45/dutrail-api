import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  deriveOAuthStateKey,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MS,
  sealOAuthState,
} from './oauth-state-cookie.js';
import { OAUTH_STATE_MISMATCH, OAuthStateStore } from './oauth-state.store.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const JWT_SECRET = 'segredo-de-teste-com-pelo-menos-32-caracteres';
// O que a strategy gera: base64url de 32 bytes.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

function createStore(cookieSecure = true): OAuthStateStore {
  const values: Partial<EnvironmentVariables> = {
    JWT_SECRET,
    COOKIE_SECURE: cookieSecure,
  };
  const config = {
    get: (name: keyof EnvironmentVariables) => values[name],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return new OAuthStateStore(config);
}

function createResponse() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
}

/** Roda o `store` como a strategy faz e devolve o state e o cookie setado. */
function runStore(store: OAuthStateStore) {
  const res = createResponse();
  const req = { res } as unknown as Request;
  const callback = vi.fn();
  store.store(req, VERIFIER, undefined, {}, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  const [err, state] = callback.mock.calls[0] as [Error | null, string];
  expect(err).toBeNull();
  expect(res.cookie).toHaveBeenCalledTimes(1);
  const [name, value, options] = res.cookie.mock.calls[0] as [
    string,
    string,
    Record<string, unknown>,
  ];
  return { state, name, value, options, callback };
}

function runVerify(
  store: OAuthStateStore,
  cookies: Record<string, unknown> | undefined,
  providedState: unknown,
) {
  const callback = vi.fn();
  store.verify({ cookies } as unknown as Request, providedState, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0] as [Error | null, string | false, unknown];
}

describe('OAuthStateStore (A-02)', () => {
  const store = createStore();
  const logSpies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
    (level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
  );

  beforeEach(() => {
    vi.mocked(timingSafeEqual).mockClear();
    logSpies.forEach((spy) => spy.mockClear());
  });
  afterAll(() => vi.restoreAllMocks());

  it('tem as aridades que o passport-oauth2 1.8 usa para PKCE (store 5, verify 3)', () => {
    // strategy.js escolhe a chamada pelo `.length`: com outra aridade o
    // verifier não chegaria ao store, ou não voltaria para a troca do code.
    expect(store.store.length).toBe(5);
    expect(store.verify.length).toBe(3);
  });

  describe('store', () => {
    it('seta o cookie HttpOnly, SameSite=Lax, Path=/auth/google, Secure e 10 minutos', () => {
      const { name, options } = runStore(store);
      expect(name).toBe(OAUTH_STATE_COOKIE_NAME);
      expect(options).toEqual({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/auth/google',
        maxAge: OAUTH_STATE_TTL_MS,
      });
      expect(OAUTH_STATE_TTL_MS).toBe(600_000);
    });

    it('Secure segue o COOKIE_SECURE', () => {
      const { options } = runStore(createStore(false));
      expect(options.secure).toBe(false);
    });

    it('devolve um state aleatório de 256 bits, diferente a cada início', () => {
      const a = runStore(store).state;
      const b = runStore(store).state;
      expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(a).not.toBe(b);
    });

    it('o verifier só existe dentro do cookie assinado: nem no state (vai para a URL) nem em log', () => {
      const { state, value, callback } = runStore(store);

      expect(state).not.toContain(VERIFIER);
      expect(JSON.stringify(callback.mock.calls)).not.toContain(VERIFIER);
      for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();

      // Dentro do cookie, protegido pela assinatura.
      const payload = JSON.parse(
        Buffer.from(value.split('.')[0], 'base64url').toString('utf8'),
      ) as { s: string; v: string };
      expect(payload).toMatchObject({ s: state, v: VERIFIER });
    });

    it('falha (sem cookie) se o verifier não seguir a RFC 7636 ou faltar req.res', () => {
      const res = createResponse();
      const callback = vi.fn();
      store.store(
        { res } as unknown as Request,
        'curto',
        undefined,
        {},
        callback,
      );
      expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(res.cookie).not.toHaveBeenCalled();

      const noRes = vi.fn();
      store.store({} as Request, VERIFIER, undefined, {}, noRes);
      expect(noRes.mock.calls[0][0]).toBeInstanceOf(Error);
    });
  });

  describe('verify', () => {
    it('com o cookie e o mesmo state, devolve o verifier para a troca do code', () => {
      const { state, value } = runStore(store);
      const [err, ok] = runVerify(
        store,
        { [OAUTH_STATE_COOKIE_NAME]: value },
        state,
      );
      expect(err).toBeNull();
      expect(ok).toBe(VERIFIER);
    });

    it('compara o state em tempo constante', () => {
      const { state, value } = runStore(store);
      vi.mocked(timingSafeEqual).mockClear();
      runVerify(store, { [OAUTH_STATE_COOKIE_NAME]: value }, `${state}x`);
      // Assinatura do cookie + state: as duas passam pelo timingSafeEqual.
      expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['cookie ausente', () => ({ cookies: {}, state: runStore(store).state })],
      ['sem cookie-parser', () => ({ cookies: undefined, state: 'x' })],
      [
        'state divergente',
        () => {
          const { value } = runStore(store);
          return {
            cookies: { [OAUTH_STATE_COOKIE_NAME]: value },
            state: runStore(store).state,
          };
        },
      ],
      [
        'state ausente',
        () => ({
          cookies: { [OAUTH_STATE_COOKIE_NAME]: runStore(store).value },
          state: undefined,
        }),
      ],
      [
        'state repetido na query (array)',
        () => {
          const { state, value } = runStore(store);
          return {
            cookies: { [OAUTH_STATE_COOKIE_NAME]: value },
            state: [state, state],
          };
        },
      ],
      [
        'cookie adulterado',
        () => {
          const { state, value } = runStore(store);
          return {
            cookies: { [OAUTH_STATE_COOKIE_NAME]: `${value}x` },
            state,
          };
        },
      ],
      [
        'cookie expirado',
        () => {
          const state = 's'.repeat(43);
          const sealed = sealOAuthState(
            deriveOAuthStateKey(JWT_SECRET),
            { state, verifier: VERIFIER },
            Date.now() - OAUTH_STATE_TTL_MS - 1,
          );
          return { cookies: { [OAUTH_STATE_COOKIE_NAME]: sealed }, state };
        },
      ],
      [
        'cookie de outro segredo',
        () => {
          const state = 's'.repeat(43);
          const sealed = sealOAuthState(
            deriveOAuthStateKey('outro-segredo-com-32-caracteres!!'),
            { state, verifier: VERIFIER },
          );
          return { cookies: { [OAUTH_STATE_COOKIE_NAME]: sealed }, state };
        },
      ],
    ])('recusa: %s', (_label, scenario) => {
      const { cookies, state } = scenario();
      const [err, ok, info] = runVerify(store, cookies, state);
      expect(err).toBeNull();
      expect(ok).toBe(false);
      expect(info).toBe(OAUTH_STATE_MISMATCH);
      expect(JSON.stringify(info)).not.toContain(VERIFIER);
    });
  });

  it('clear apaga com as mesmas opções do set (sem maxAge)', () => {
    const res = createResponse();
    store.clear(res as unknown as Response);
    expect(res.clearCookie).toHaveBeenCalledWith(OAUTH_STATE_COOKIE_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/auth/google',
    });
  });
});
