import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import {
  ACCESS_TOKEN_AUDIENCE,
  REFRESH_TOKEN_AUDIENCE,
} from '../../src/auth/jwt.constants.js';

/**
 * Forja JWTs com os segredos do .env.test, para testar o que a API faz com
 * tokens que ela não emitiu (claims erradas, outro algoritmo, expirados).
 * Vale para as apps que usam os segredos do arquivo (fora de NODE_ENV=production,
 * em que o createAppWithEnv gera segredos aleatórios).
 */
const testEnv = parse(readFileSync('.env.test'));

export type TokenKind = 'access' | 'refresh';

const SECRET: Record<TokenKind, string> = {
  access: testEnv.JWT_SECRET,
  refresh: testEnv.JWT_REFRESH_SECRET,
};

const AUDIENCE: Record<TokenKind, string> = {
  access: ACCESS_TOKEN_AUDIENCE,
  refresh: REFRESH_TOKEN_AUDIENCE,
};

/** `iss` e `aud` que a API põe no tipo de token (JWT_ISSUER padrão). */
export function claimsOf(kind: TokenKind) {
  return {
    issuer: testEnv.JWT_ISSUER ?? 'dutrail-api',
    audience: AUDIENCE[kind],
  };
}

/**
 * Assina com o segredo do tipo. `options` define as claims por inteiro
 * (o jsonwebtoken recusa `undefined`): passe `claimsOf(kind)` para o formato
 * atual, ou omita `issuer`/`audience` para o formato anterior ao A-14.
 */
export function signWithSecretOf(
  kind: TokenKind,
  payload: object,
  options: Omit<JwtSignOptions, 'secret'> = {},
): string {
  return new JwtService().sign(
    { ...payload },
    { secret: SECRET[kind], expiresIn: '1d', ...options },
  );
}
