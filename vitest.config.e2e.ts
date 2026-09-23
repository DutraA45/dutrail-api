import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Carrega .env.test e aplica as migrations antes de qualquer arquivo rodar.
    globalSetup: ['./test/global-setup.ts'],
    env: { NODE_ENV: 'test' },
    // Os arquivos compartilham o mesmo banco e limpam as tabelas entre testes;
    // rodá-los em paralelo faria um apagar os dados do outro.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
