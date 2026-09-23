import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';

/**
 * Guard global (registrado como APP_GUARD no AuthModule).
 *
 * Para cada request: se a rota (ou o controller) tem @Public(), libera sem
 * olhar o token. Senão, delega ao AuthGuard('jwt') do @nestjs/passport, que
 * roda a JwtStrategy e lança 401 se o token for inválido/ausente.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    // getAllAndOverride: metadata do handler tem prioridade sobre a da classe.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }
}
