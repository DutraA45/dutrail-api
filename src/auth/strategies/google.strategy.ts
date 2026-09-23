import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';
import { EnvironmentVariables } from '../../config/env.validation.js';
import type { User } from '../../generated/prisma/client.js';
import { AuthService } from '../auth.service.js';
import type { GoogleProfile } from '../interfaces/google-profile.interface.js';

/**
 * Strategy do Passport para o Google OAuth 2.0 (authorization code flow).
 *
 * - GET /auth/google: o guard chama `authenticate()`, que redireciona o
 *   browser para a tela de consentimento do Google.
 * - GET /auth/google/callback?code=...: o guard chama `authenticate()` de
 *   novo; a strategy troca o `code` por tokens do Google, baixa o perfil e
 *   chama `validate()`. O retorno vira `req.user`.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService<EnvironmentVariables, true>,
    private readonly authService: AuthService,
  ) {
    super({
      clientID: config.get('GOOGLE_CLIENT_ID', { infer: true }),
      clientSecret: config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
      callbackURL: config.get('GOOGLE_CALLBACK_URL', { infer: true }),
      scope: ['email', 'profile'],
    });
  }

  /**
   * Os tokens do Google (1º e 2º args) são ignorados: só precisamos da
   * identidade, não de chamar APIs do Google em nome do usuário.
   */
  validate(
    _googleAccessToken: string,
    _googleRefreshToken: string,
    profile: Profile,
  ): Promise<User> {
    return this.authService.loginWithGoogle(
      GoogleStrategy.toGoogleProfile(profile),
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
