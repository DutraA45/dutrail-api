import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ActivityFileStorageService } from '../../src/activities/storage/activity-file-storage.service.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { BreachedPasswordService } from '../../src/auth/breached-password.service.js';
import {
  InMemoryLoginAttemptsStore,
  LoginAttemptsStore,
} from '../../src/auth/login-attempts.store.js';
import { GoogleStrategy } from '../../src/auth/strategies/google.strategy.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { FakeActivityFileStorage } from '../fakes/fake-activity-file-storage.js';
import {
  FakeBreachedPasswordService,
  fakeBreachedPasswords,
} from '../fakes/fake-breached-password.service.js';
import { FakeGoogleStrategy } from '../fakes/fake-google.strategy.js';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  /** Bucket em memória no lugar do object storage real. */
  storage: FakeActivityFileStorage;
  /** Contagens do limite de login por conta (A-03), em memória. */
  loginAttempts: InMemoryLoginAttemptsStore;
  /**
   * Limpa todas as tabelas (CASCADE cuida das tabelas filhas de User), o
   * storage fake, que faz parte do mesmo estado persistente, e a lista de
   * senhas vazadas falsa.
   * storage fake e as contagens de login por conta, que fazem parte do mesmo
   * estado persistente.
   */
  resetDb(): Promise<void>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  keepThrottling?: boolean;
  /**
   * Mantém o BreachedPasswordService real (com `fetch` stubado pelo teste),
   * para conferir a ligação com o env. Sem isso, o fake: nunca vai à rede.
   */
  realBreachedPasswordCheck?: boolean;
}

/**
 * Sobe a aplicação completa (módulos reais, banco real) com quatro substituições:
 * - GoogleStrategy -> FakeGoogleStrategy (não chama o Google);
 * - ActivityFileStorageService -> FakeActivityFileStorage (não chama o bucket);
 * - BreachedPasswordService -> FakeBreachedPasswordService (não chama o Have
 *   I Been Pwned), exceto com `realBreachedPasswordCheck`;
 * - ThrottlerGuard -> liberado, exceto quando `keepThrottling` é true (usado
 *   no teste específico de rate limit).
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestApp> {
  const storage = new FakeActivityFileStorage();
  let builder: TestingModuleBuilder = Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(GoogleStrategy)
    .useClass(FakeGoogleStrategy)
    .overrideProvider(ActivityFileStorageService)
    .useValue(storage);

  if (!options.realBreachedPasswordCheck) {
    builder = builder
      .overrideProvider(BreachedPasswordService)
      .useClass(FakeBreachedPasswordService);
  }

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
  const loginAttempts = app.get(LoginAttemptsStore);
  if (!(loginAttempts instanceof InMemoryLoginAttemptsStore)) {
    throw new Error('os e2e esperam o store de tentativas em memória');
  }

  return {
    app,
    prisma,
    storage,
    loginAttempts,
    resetDb: async () => {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
      storage.reset();
      fakeBreachedPasswords.reset();
      loginAttempts.clear();
    },
    close: () => app.close(),
  };
}
