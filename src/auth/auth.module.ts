import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { SecurityLogModule } from '../security/security-log.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { ExpiredTokensCleanupService } from './expired-tokens-cleanup.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import {
  InMemoryLoginAttemptsStore,
  LoginAttemptsStore,
} from './login-attempts.store.js';
import { OAuthStateStore } from './oauth-state.store.js';
import { PasswordService } from './password.service.js';
import { RefreshTokenTransport } from './refresh-token-transport.service.js';
import { GoogleStrategy } from './strategies/google.strategy.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [
    UsersModule,
    SecurityLogModule,
    // session: false -> sem cookies de sessão do passport; somos 100% token.
    PassportModule.register({ session: false }),
    // Sem opções globais: segredo e expiração são passados a cada sign/verify
    // no TokenService, porque access e refresh usam segredos diferentes.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    PasswordService,
    // Sabe apenas POR ONDE o refresh token entra e sai (cookie vs corpo).
    RefreshTokenTransport,
    // Cookie assinado com o state + code_verifier do login com Google (A-02).
    OAuthStateStore,
    // Strategies são providers comuns: ao serem instanciadas se registram no
    // passport (pelo mixin PassportStrategy) sob os nomes 'jwt' e 'google'.
    JwtStrategy,
    GoogleStrategy,
    // Limite de falhas de login por conta (A-03). O store em memória vale
    // para uma instância; para várias, troque por uma implementação em Redis.
    LoginAttemptsService,
    {
      provide: LoginAttemptsStore,
      useFactory: () => new InMemoryLoginAttemptsStore(),
    },
    // Job diário que apaga refresh tokens e códigos de troca expirados (A-12).
    ExpiredTokensCleanupService,
    // Guard global: toda rota exige Bearer válido, salvo as marcadas @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
