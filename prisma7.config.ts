// Configuração da CLI do Prisma (migrate, generate, studio).
// A CLI não lê .env sozinha; por isso importamos dotenv aqui.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
