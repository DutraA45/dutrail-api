import { execSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';

/**
 * Roda UMA vez antes de todos os arquivos e2e (vitest `globalSetup`).
 *
 * 1. Carrega .env.test no process.env (sem sobrescrever variáveis já
 *    definidas — assim o CI pode injetar outro DATABASE_URL).
 * 2. Aplica as migrations no banco de teste. `migrate deploy` é idempotente
 *    e não gera migrations novas (diferente de `migrate dev`).
 */
export default function setup(): void {
  loadEnv({ path: '.env.test' });

  if (!process.env.DATABASE_URL?.includes('test')) {
    // Salvaguarda: os testes TRUNCAM tabelas.
    throw new Error(
      `DATABASE_URL dos testes precisa apontar para um banco de teste (contém "test"). Recebido: ${process.env.DATABASE_URL}`,
    );
  }

  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
}
