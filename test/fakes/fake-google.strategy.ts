import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Profile } from 'passport-google-oauth20';
import request from 'supertest';
import { AuthService } from '../../src/auth/auth.service.js';
import { OAuthStateStore } from '../../src/auth/oauth-state.store.js';
import { GoogleStrategy } from '../../src/auth/strategies/google.strategy.js';
import type { EnvironmentVariables } from '../../src/config/env.validation.js';

/** Pedido recebido pelo endpoint de token falso. */
export interface FakeTokenRequest {
  code: string;
  codeVerifier?: string;
}

/**
 * Estado do "Google falso". Os testes trocam o perfil antes do callback e
 * leem os pedidos de token para conferir o PKCE.
 */
export const fakeGoogle = {
  profile: null as Profile | null,
  tokenRequests: [] as FakeTokenRequest[],
  reset() {
    this.profile = null;
    this.tokenRequests = [];
  },
};

export function makeGoogleProfile(
  overrides: Partial<Profile> & { email?: string; verified?: boolean },
): Profile {
  const { email = 'google@example.com', verified = true, ...rest } = overrides;
  return {
    id: 'google-id-1',
    provider: 'google',
    displayName: 'Google User',
    emails: [{ value: email, verified }],
    photos: [{ value: 'https://lh3.googleusercontent.com/fake.png' }],
    _raw: '',
    _json: {} as Profile['_json'],
    ...rest,
  } as Profile;
}

const CODE_PREFIX = 'fake-google-code.';
const STATE_COOKIE = 'googleOAuthState';

/** Resposta do endpoint de token do Google para um `code` recusado. */
const INVALID_GRANT = {
  statusCode: 400,
  data: JSON.stringify({
    error: 'invalid_grant',
    error_description: 'Malformed auth code.',
  }),
};

type TokenCallback = (
  err: { statusCode: number; data: string } | null,
  accessToken?: string,
  refreshToken?: string,
  params?: Record<string, unknown>,
) => void;

/**
 * A GoogleStrategy REAL (passport-oauth2: state, PKCE, OAuthStateStore,
 * tratamento de `error=` e de TokenError) com só as duas chamadas de rede
 * trocadas:
 * - endpoint de token: aceita o `code` emitido por `consentAt()` apenas com o
 *   `code_verifier` cujo S256 é o `code_challenge` daquele redirect, como o
 *   Google; senão responde `invalid_grant` (que a strategy vira TokenError);
 * - userinfo: devolve `fakeGoogle.profile` (sem perfil, um Error comum, que
 *   simula uma falha inesperada).
 *
 * Substitui a GoogleStrategy via `overrideProvider` e se registra no passport
 * com o mesmo nome ('google'); o `validate()` é o da strategy real.
 */
@Injectable()
export class FakeGoogleStrategy extends GoogleStrategy {
  constructor(
    config: ConfigService<EnvironmentVariables, true>,
    authService: AuthService,
    stateStore: OAuthStateStore,
  ) {
    super(config, authService, stateStore);
    const redirectUri = config.get('GOOGLE_CALLBACK_URL', { infer: true });

    this._oauth2.getOAuthAccessToken = ((
      code: string,
      params: Record<string, string>,
      callback: TokenCallback,
    ) => {
      const codeVerifier = params.code_verifier;
      fakeGoogle.tokenRequests.push({ code, codeVerifier });

      const challenge = code.startsWith(CODE_PREFIX)
        ? code.slice(CODE_PREFIX.length)
        : undefined;
      const valid =
        challenge !== undefined &&
        codeVerifier !== undefined &&
        s256(codeVerifier) === challenge &&
        params.grant_type === 'authorization_code' &&
        params.redirect_uri === redirectUri;
      if (!valid) {
        callback(INVALID_GRANT);
        return;
      }
      callback(null, 'google-access-token', 'google-refresh-token', {});
    }) as typeof this._oauth2.getOAuthAccessToken;
  }

  override userProfile(
    _accessToken: string,
    done: (err?: unknown, profile?: Profile) => void,
  ): void {
    if (!fakeGoogle.profile) {
      done(new Error('fakeGoogle.profile não configurado no teste'));
      return;
    }
    done(null, fakeGoogle.profile);
  }
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * O usuário aprova na tela de consentimento: a partir do redirect do passo 1
 * (Location para accounts.google.com), devolve o que o Google mandaria ao
 * callback. O `code` carrega o `code_challenge`, como o Google o guarda do
 * lado dele.
 */
export function consentAt(authorizeLocation: string): {
  code: string;
  state: string;
} {
  const url = new URL(authorizeLocation);
  expect(url.origin).toBe('https://accounts.google.com');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const challenge = url.searchParams.get('code_challenge');
  const state = url.searchParams.get('state');
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(state).toBeTruthy();
  return { code: `${CODE_PREFIX}${challenge}`, state: state! };
}

/** `/auth/google/callback?...` montado como o Google montaria. */
export function callbackPath(params: Record<string, string>): string {
  return `/auth/google/callback?${new URLSearchParams(params).toString()}`;
}

type Agent = ReturnType<typeof request.agent>;

/**
 * Passo 1 num agent com cookie jar (o browser) + consentimento: depois disto o
 * agent tem o cookie de state, e basta chamar `callbackPath(consent)`.
 * `stateCookie` é o valor selado do Set-Cookie (para os testes de adulteração
 * e de vazamento) e `setCookie` o header cru (para os atributos).
 */
export async function startGoogleLogin(
  agent: Agent,
  userAgent?: string,
): Promise<{
  code: string;
  state: string;
  location: string;
  stateCookie: string;
  setCookie: string;
}> {
  let start = agent.get('/auth/google');
  if (userAgent) start = start.set('User-Agent', userAgent);
  const res = await start.expect(302);
  const location = res.headers.location as string;
  const header = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const setCookie = header.find((c) => c.startsWith(`${STATE_COOKIE}=`));
  expect(setCookie).toBeDefined();
  const stateCookie = decodeURIComponent(
    setCookie!.slice(STATE_COOKIE.length + 1).split(';')[0],
  );
  return {
    ...consentAt(location),
    location,
    stateCookie,
    setCookie: setCookie!,
  };
}

/**
 * Fluxo completo até o callback, num browser novo. Devolve a resposta do
 * callback (o 302 para o frontend).
 */
export async function googleCallback(
  server: Parameters<typeof request.agent>[0],
  userAgent?: string,
) {
  const browser = request.agent(server);
  const consent = await startGoogleLogin(browser, userAgent);
  let callback = browser.get(callbackPath(consent));
  if (userAgent) callback = callback.set('User-Agent', userAgent);
  const res = await callback;
  return res;
}

/** O `code` de troca do redirect de sucesso para o frontend. */
export function exchangeCodeOf(callbackLocation: string): string {
  const url = new URL(callbackLocation);
  expect(url.pathname).toBe('/auth/callback');
  const code = url.searchParams.get('code');
  expect(code).toBeTruthy();
  return code!;
}
