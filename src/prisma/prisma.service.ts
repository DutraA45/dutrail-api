import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Wrapper injetável do PrismaClient. Estender a classe gerada permite usar
 * `this.prisma.user.findUnique(...)` diretamente nos services.
 *
 * Prisma 7 exige um "driver adapter": aqui usamos o driver `pg`, que fala
 * TCP/SSL tanto com o Neon quanto com um Postgres local.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
      }),
    });
  }

  async onModuleInit() {
    // Conecta no boot para falhar cedo se o banco estiver inacessível.
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
