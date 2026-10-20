import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface.js';

/**
 * Extrai o usuário autenticado (colocado em `req.user` pela JwtStrategy).
 *
 * Uso: `@Get('me') me(@CurrentUser() user: AuthenticatedUser) { ... }`
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
