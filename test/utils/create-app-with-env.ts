import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import type { TestApp } from './create-app.js';

/**
 * Sobe a app com outro ambiente. O ConfigModule lê (e valida) o ambiente
 * quando o AppModule é importado, então o módulo é reimportado depois de
 * trocar o env — e um env inválido faz esta função rejeitar com o erro do boot.
 *
 * Todas as variáveis vêm do .env.test (o process.env vence os arquivos, então o
 * .env de desenvolvimento, que o AppModule passa a ler fora de NODE_ENV=test,
 * não contribui com nada — em especial o DATABASE_URL). Em produção a
 * validação exige credenciais sem trechos de placeholder e segredos JWT de
 * 256 bits: geramos valores aleatórios só para este processo, e religamos o
 * COOKIE_SECURE. `overrides` é aplicado por último.
 */
export async function createAppWithEnv(
  overrides: Record<string, string> = {},
): Promise<TestApp> {
  vi.resetModules();
  vi.unstubAllEnvs();

  // Como no global-setup: um DATABASE_URL injetado (ex.: CI) vence o do arquivo.
  const injectedDatabaseUrl = process.env.DATABASE_URL;
  const env = parse(readFileSync('.env.test'));
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  if (injectedDatabaseUrl) vi.stubEnv('DATABASE_URL', injectedDatabaseUrl);
  if (overrides.NODE_ENV === 'production') {
    vi.stubEnv('JWT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('JWT_REFRESH_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('GOOGLE_CLIENT_SECRET', randomBytes(16).toString('hex'));
    vi.stubEnv('OCI_S3_SECRET_KEY', randomBytes(16).toString('hex'));
    // O .env.test desliga o Secure, o que produção recusa.
    vi.stubEnv('COOKIE_SECURE', 'true');
  }
  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value);
  }
  // Salvaguarda igual à do global-setup: nunca subir contra outro banco.
  expect(process.env.DATABASE_URL).toContain('test');

  const { createTestApp } = await import('./create-app.js');
  return createTestApp();
}
