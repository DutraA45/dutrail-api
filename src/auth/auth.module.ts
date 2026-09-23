import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PasswordService } from './password.service.js';
import { RefreshTokenTransport } from './refresh-token-transport.service.js';
import { GoogleStrategy } from './strategies/google.strategy.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [
    UsersModule,
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
    // Strategies são providers comuns: ao serem instanciadas se registram no
    // passport (pelo mixin PassportStrategy) sob os nomes 'jwt' e 'google'.
    JwtStrategy,
    GoogleStrategy,
    // Guard global: toda rota exige Bearer válido, salvo as marcadas @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
