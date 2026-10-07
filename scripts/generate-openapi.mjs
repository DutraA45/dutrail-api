// Gera docs/openapi.json a partir do /docs-json da app em development.
// Uso: npm run openapi:generate (compila com `nest build` antes).
//
// Reproduzível e sem segredos reais:
// - o ambiente vem só do .env.test (valores de teste, versionados), com
//   NODE_ENV=development; o shell não influencia;
// - o .env de desenvolvimento nunca é lido: a app sobe com o cwd num diretório
//   temporário vazio, onde o ConfigModule não encontra arquivo .env;
// - não precisa de banco: o PrismaService é substituído por um stub (como os
//   e2e substituem storage e Google), e o DATABASE_URL aponta para lugar nenhum.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Test } from '@nestjs/testing';
import { parse } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs', 'openapi.json');

const env = {
  ...parse(readFileSync(join(root, '.env.test'))),
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi',
  SECURITY_LOG_ENABLED: 'false',
  SCHEDULER_ENABLED: 'false',
  BREACHED_PASSWORD_CHECK: 'false',
};
Object.assign(process.env, env);

const dist = (path) => pathToFileURL(join(root, 'dist', path)).href;

const workDir = mkdtempSync(join(tmpdir(), 'dutrail-openapi-'));
process.chdir(workDir);
try {
  // Importados depois do chdir e do env: o ConfigModule resolve o .env no
  // carregamento do AppModule.
  const { AppModule } = await import(dist('app.module.js'));
  const { configureApp } = await import(dist('app.setup.js'));
  const { PrismaService } = await import(dist('prisma/prisma.service.js'));

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`${await app.getUrl()}/docs-json`);
    if (!res.ok) throw new Error(`/docs-json respondeu ${res.status}`);
    const doc = await res.json();
    writeFileSync(output, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`OpenAPI ${doc.openapi} gravado em docs/openapi.json`);
  } finally {
    await app.close();
  }
} finally {
  process.chdir(root);
  rmSync(workDir, { recursive: true, force: true });
}
