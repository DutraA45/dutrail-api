import { UnauthorizedException } from '@nestjs/common';
import type { Profile } from 'passport-google-oauth20';
import { GoogleStrategy } from './google.strategy.js';

function profile(overrides: Partial<Profile>): Profile {
  return {
    id: 'g-1',
    provider: 'google',
    displayName: 'Ana',
    _raw: '',
    _json: {} as any,
    ...overrides,
  } as Profile;
}

describe('GoogleStrategy.toGoogleProfile', () => {
  it('mapeia o Profile do passport para o formato interno', () => {
    const result = GoogleStrategy.toGoogleProfile(
      profile({
        emails: [{ value: 'ana@example.com', verified: true }],
        photos: [{ value: 'https://img/ana.png' }],
      }),
    );
    expect(result).toEqual({
      googleId: 'g-1',
      email: 'ana@example.com',
      emailVerified: true,
      name: 'Ana',
      avatarUrl: 'https://img/ana.png',
    });
  });

  it('aceita "true" como string em email_verified', () => {
    const result = GoogleStrategy.toGoogleProfile(
      profile({
        emails: [{ value: 'a@b.com', verified: 'true' as unknown as boolean }],
      }),
    );
    expect(result.emailVerified).toBe(true);
  });

  it('marca como não verificado quando o Google não afirma que é', () => {
    const result = GoogleStrategy.toGoogleProfile(
      profile({ emails: [{ value: 'a@b.com', verified: false }] }),
    );
    expect(result.emailVerified).toBe(false);
  });

  it('rejeita perfil sem email', () => {
    expect(() =>
      GoogleStrategy.toGoogleProfile(profile({ emails: [] })),
    ).toThrow(UnauthorizedException);
  });
});
