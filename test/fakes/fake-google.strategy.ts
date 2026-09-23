import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import type { Profile } from 'passport-google-oauth20';
import { Strategy as BaseStrategy } from 'passport-strategy';
import { AuthService } from '../../src/auth/auth.service.js';
import { GoogleStrategy } from '../../src/auth/strategies/google.strategy.js';

/**
 * Perfil que o "Google falso" vai devolver. Os testes trocam este valor antes
 * de chamar GET /auth/google/callback.
 */
export const fakeGoogle = { profile: null as Profile | null };

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

type VerifyCallback = (
  accessToken: string,
  refreshToken: string,
  profile: Profile,
  done: (err: unknown, user?: unknown) => void,
) => void;

/**
 * Strategy base que imita o comportamento do passport-google-oauth20 sem
 * falar com o Google:
 * - sem `?code=`: redireciona (como o passo 1 real);
 * - com `?code=`: chama o `verify` (= o `validate()` da classe abaixo) com
 *   o perfil configurado em `fakeGoogle.profile`.
 */
class FakeGoogleBaseStrategy extends BaseStrategy {
  constructor(
    _options: unknown,
    private readonly verify: VerifyCallback,
  ) {
    super();
  }

  override authenticate(req: Request): void {
    if (!req.query['code']) {
      this.redirect('https://accounts.google.com/o/oauth2/v2/auth?fake=1');
      return;
    }
    if (!fakeGoogle.profile) {
      this.error(new Error('fakeGoogle.profile não configurado no teste'));
      return;
    }
    this.verify(
      'google-access-token',
      'google-refresh-token',
      fakeGoogle.profile,
      (err, user) => {
        if (err) return this.error(err as Error);
        if (!user) return this.fail(401);
        this.success(user);
      },
    );
  }
}

/**
 * Substitui a GoogleStrategy real via `overrideProvider` no e2e. Registra-se
 * no passport com o mesmo nome ('google'), então o GoogleAuthGuard e o
 * controller não precisam saber que é falsa. O `validate()` é o mesmo da
 * strategy real, para exercitar a lógica de criação/vinculação de conta.
 */
@Injectable()
export class FakeGoogleStrategy extends PassportStrategy(
  FakeGoogleBaseStrategy,
  'google',
) {
  constructor(private readonly authService: AuthService) {
    super({});
  }

  validate(_accessToken: string, _refreshToken: string, profile: Profile) {
    return this.authService.loginWithGoogle(
      GoogleStrategy.toGoogleProfile(profile),
    );
  }
}
