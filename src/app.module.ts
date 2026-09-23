import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { EnvironmentVariables, validateEnv } from './config/env.validation.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Em testes, .env.test tem prioridade sobre .env (o primeiro arquivo da
      // lista vence). Variáveis já presentes no process.env vencem ambos.
      envFilePath:
        process.env.NODE_ENV === 'test' ? ['.env.test', '.env'] : ['.env'],
      validate: validateEnv,
    }),
    ThrottlerModule.forRootAsync({
      // ConfigModule é global, mas o tipo ThrottlerAsyncOptions exige `imports`.
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        throttlers: [
          {
            ttl: config.get('THROTTLE_TTL_MS', { infer: true }),
            limit: config.get('THROTTLE_LIMIT', { infer: true }),
          },
        ],
      }),
    }),
    PrismaModule,
    UsersModule,
    AuthModule,
  ],
  providers: [
    // Rate limiting em toda a API (por IP). Rotas sensíveis apertam mais com
    // @Throttle(); ver AuthController.
    // `useExisting` (em vez de `useClass`) registra o guard também sob o
    // token ThrottlerGuard, o que permite `overrideProvider(ThrottlerGuard)` nos
    // testes e2e — com `useClass` só existiria o token APP_GUARD.
    ThrottlerGuard,
    { provide: APP_GUARD, useExisting: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
