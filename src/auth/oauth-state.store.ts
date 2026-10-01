import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { EnvironmentVariables } from '../config/env.validation.js';
import {
  deriveOAuthStateKey,
  generateOAuthState,
  isCodeVerifier,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_COOKIE_PATH,
  OAUTH_STATE_TTL_MS,
  openOAuthState,
  safeEqual,
  sealOAuthState,
} from './oauth-state-cookie.js';

/**
 * `info` com que o `verify` recusa o state. O passport-oauth2 o repassa intacto
 * ao `fail()`, e o GoogleCallbackGuard o reconhece por identidade.
 */
export const OAUTH_STATE_MISMATCH = Object.freeze({
  message: 'state_mismatch',
});

type StoreCallback = (err: Error | null, state?: string) => void;
/** `ok` string = o code_verifier, que o passport-oauth2 envia na troca do code. */
type VerifyCallback = (
  err: Error | null,
  ok: string | false,
  info?: unknown,
) => void;

/**
 * Store de `state` + PKCE do passport-oauth2 (A-02), no lugar do de sessão.
 *
 * O passport-oauth2 1.8 escolhe a assinatura pela aridade
 * (node_modules/passport-oauth2/lib/strategy.js): `store` com 5 parâmetros
 * recebe o `code_verifier` que a própria strategy gerou (e de que já derivou o
 * `code_challenge`); `verify` com 3 devolve o verifier como `ok`, e a strategy
 * o envia na troca do code. Por isso os parâmetros não podem ter default.
 *
 * O `store` recebe só o `req`, mas precisa setar o cookie antes de a strategy
 * responder o 302: usa o `req.res`, que o Express liga a toda request.
 * O GoogleCallbackGuard apaga o cookie no callback, em qualquer desfecho.
 */
@Injectable()
export class OAuthStateStore {
  private readonly key: Buffer;
  private readonly secure: boolean;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    // Chave derivada do JWT_SECRET (HKDF com rótulo próprio): sem variável nova.
    this.key = deriveOAuthStateKey(config.get('JWT_SECRET', { infer: true }));
    this.secure = config.get('COOKIE_SECURE', { infer: true });
  }

  /**
   * Opções do cookie, iguais no set e no clear. `lax`, não `strict`: o
   * callback chega por navegação vinda de accounts.google.com, e com `strict`
   * o browser não enviaria o cookie.
   */
  cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: OAUTH_STATE_COOKIE_PATH,
    };
  }

  store(
    req: Request,
    verifier: string,
    _state: unknown,
    _meta: unknown,
    callback: StoreCallback,
  ): void {
    const res = req.res;
    if (!res) {
      return callback(new Error('OAuthStateStore precisa de req.res'));
    }
    if (!isCodeVerifier(verifier)) {
      return callback(new Error('code_verifier fora da RFC 7636'));
    }
    const state = generateOAuthState();
    res.cookie(
      OAUTH_STATE_COOKIE_NAME,
      sealOAuthState(this.key, { state, verifier }),
      { ...this.cookieOptions(), maxAge: OAUTH_STATE_TTL_MS },
    );
    callback(null, state);
  }

  verify(req: Request, providedState: unknown, callback: VerifyCallback): void {
    const stored = openOAuthState(
      this.key,
      (req.cookies as Record<string, unknown> | undefined)?.[
        OAUTH_STATE_COOKIE_NAME
      ],
    );
    if (
      !stored ||
      typeof providedState !== 'string' ||
      !safeEqual(providedState, stored.state)
    ) {
      return callback(null, false, OAUTH_STATE_MISMATCH);
    }
    callback(null, stored.verifier);
  }

  /** Sem `maxAge`: o `clearCookie` do Express 5 já força a expiração. */
  clear(res: Response): void {
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, this.cookieOptions());
  }
}
