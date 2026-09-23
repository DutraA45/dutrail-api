import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca uma rota como acessível sem access token.
 *
 * O JwtAuthGuard é global (tudo protegido por padrão); este decorator é a
 * exceção explícita. Assim é impossível esquecer de proteger uma rota nova.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
