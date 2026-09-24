import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ActivityFileStorageService } from '../../src/activities/storage/activity-file-storage.service.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { GoogleStrategy } from '../../src/auth/strategies/google.strategy.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { FakeActivityFileStorage } from '../fakes/fake-activity-file-storage.js';
import { FakeGoogleStrategy } from '../fakes/fake-google.strategy.js';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  /** Bucket em memória no lugar do object storage real. */
  storage: FakeActivityFileStorage;
  /**
   * Limpa todas as tabelas (CASCADE cuida das tabelas filhas de User) e o
   * storage fake, que faz parte do mesmo estado persistente.
   */
  resetDb(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Sobe a aplicação completa (módulos reais, banco real) com três substituições:
 * - GoogleStrategy -> FakeGoogleStrategy (não chama o Google);
 * - ActivityFileStorageService -> FakeActivityFileStorage (não chama o bucket);
 * - ThrottlerGuard -> liberado, exceto quando `keepThrottling` é true (usado
 *   no teste específico de rate limit).
 */
export async function createTestApp(
  options: { keepThrottling?: boolean } = {},
): Promise<TestApp> {
  const storage = new FakeActivityFileStorage();
  let builder: TestingModuleBuilder = Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(GoogleStrategy)
    .useClass(FakeGoogleStrategy)
    .overrideProvider(ActivityFileStorageService)
    .useValue(storage);

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
    storage,
    resetDb: async () => {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
      storage.reset();
    },
    close: () => app.close(),
  };
}
