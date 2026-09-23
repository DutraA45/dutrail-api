import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { GoogleStrategy } from '../../src/auth/strategies/google.strategy.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { FakeGoogleStrategy } from '../fakes/fake-google.strategy.js';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  /** Limpa todas as tabelas (CASCADE cuida de RefreshToken e OAuthExchangeCode). */
  resetDb(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Sobe a aplicação completa (módulos reais, banco real) com duas substituições:
 * - GoogleStrategy -> FakeGoogleStrategy (não chama o Google);
 * - ThrottlerGuard -> liberado, exceto quando `keepThrottling` é true (usado
 *   no teste específico de rate limit).
 */
export async function createTestApp(
  options: { keepThrottling?: boolean } = {},
): Promise<TestApp> {
  let builder: TestingModuleBuilder = Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(GoogleStrategy)
    .useClass(FakeGoogleStrategy);

  if (!options.keepThrottling) {
    // overrideProvider (não overrideGuard): o guard é um provider comum aliasado
    // pelo APP_GUARD via useExisting; overrideGuard só enxerga @UseGuards().
    builder = builder
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true });
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);

  return {
    app,
    prisma,
    resetDb: async () => {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
    },
    close: () => app.close(),
  };
}
