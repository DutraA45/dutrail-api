import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { EnvironmentVariables } from '../../config/env.validation.js';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface.js';
import type { AccessTokenPayload } from '../interfaces/jwt-payload.interface.js';

/**
 * Strategy do Passport para o access token.
 *
 * O passport-jwt faz o trabalho pesado: extrai o Bearer do header, verifica a
 * assinatura e a expiração. Só se tudo passar ele chama `validate()` com o
 * payload já decodificado; o retorno vira `req.user`.
 *
 * Não consulta o banco de propósito (token stateless). Consequência: um
 * usuário apagado/banido continua "válido" até o access token expirar (15min).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET', { infer: true }),
      // Fixar o algoritmo evita ataques de "algorithm confusion".
      algorithms: ['HS256'],
    });
  }

  validate(payload: AccessTokenPayload): AuthenticatedUser {
    return { userId: payload.sub, email: payload.email };
  }
}
