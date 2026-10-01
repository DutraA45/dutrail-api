import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Profile, Strategy } from 'passport-google-oauth20';
import type { StateStore } from 'passport-oauth2';
import { EnvironmentVariables } from '../../config/env.validation.js';
import type { User } from '../../generated/prisma/client.js';
import { securityContextFrom } from '../../security/security-context.js';
import { AuthService } from '../auth.service.js';
import type { GoogleProfile } from '../interfaces/google-profile.interface.js';
import { OAuthStateStore } from '../oauth-state.store.js';

/**
 * Strategy do Passport para o Google OAuth 2.0 (authorization code flow).
 *
 * - GET /auth/google: o guard chama `authenticate()`, que redireciona o
 *   browser para a tela de consentimento do Google.
 * - GET /auth/google/callback?code=...: o guard chama `authenticate()` de
 *   novo; a strategy confere o `state`, troca o `code` por tokens do Google
 *   (com o `code_verifier`), baixa o perfil e chama `validate()`. O retorno
 *   vira `req.user`.
 *
 * `state` e PKCE (S256) protegem contra login CSRF e injeção de `code` (A-02).
 * Sem sessão, os dois ficam num cookie assinado: ver OAuthStateStore.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService<EnvironmentVariables, true>,
    private readonly authService: AuthService,
    stateStore: OAuthStateStore,
  ) {
    super({
      clientID: config.get('GOOGLE_CLIENT_ID', { infer: true }),
      clientSecret: config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
      callbackURL: config.get('GOOGLE_CALLBACK_URL', { infer: true }),
      scope: ['email', 'profile'],
      // O `req` chega ao validate() para o log de segurança (ip, user-agent).
      passReqToCallback: true,
      // Com um `store` objeto o passport-oauth2 já usa state; `state: true`
      // fica para deixar explícito. `pkce: true` = S256.
      state: true,
      pkce: true,
      // O @types/passport-oauth2 não declara a assinatura de 5 parâmetros do
      // store com PKCE, que é a que o runtime usa (ver OAuthStateStore).
      store: stateStore as unknown as StateStore,
    });
  }

  /**
   * Os tokens do Google (2º e 3º args) são ignorados: só precisamos da
   * identidade, não de chamar APIs do Google em nome do usuário.
   */
  validate(
    req: Request,
    _googleAccessToken: string,
    _googleRefreshToken: string,
    profile: Profile,
  ): Promise<User> {
    return this.authService.loginWithGoogle(
      GoogleStrategy.toGoogleProfile(profile),
      securityContextFrom(req),
    );
  }

  /** Converte o Profile do passport para o formato interno (ver GoogleProfile). */
  static toGoogleProfile(profile: Profile): GoogleProfile {
    const email = profile.emails?.[0];
    if (!email?.value) {
      throw new UnauthorizedException('Google account has no email');
    }
    return {
      googleId: profile.id,
      email: email.value,
      // O Google envia `email_verified` como boolean, mas defendemos contra "true".
      emailVerified:
        email.verified === true || String(email.verified) === 'true',
      name: profile.displayName || undefined,
      avatarUrl: profile.photos?.[0]?.value,
    };
  }
}
