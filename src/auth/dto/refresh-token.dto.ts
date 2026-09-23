import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsJWT, IsOptional } from 'class-validator';

/**
 * Corpo de /auth/refresh e /auth/logout.
 *
 * O campo é opcional no DTO porque o canal depende do X-Client-Type:
 * `mobile` manda o token aqui, `web` o manda no cookie httpOnly (e enviá-lo
 * no corpo é 400). Quem valida "está no canal certo?" é o
 * RefreshTokenTransport, que tem o tipo de cliente em mãos.
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      'Obrigatório quando X-Client-Type é `mobile`. Deve ser omitido quando é `web` ' +
      '(nesse caso o token é lido do cookie httpOnly).',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @IsOptional()
  @IsJWT()
  refreshToken?: string;
}
