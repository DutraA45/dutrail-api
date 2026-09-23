import { ApiProperty } from '@nestjs/swagger';
import { IsJWT } from 'class-validator';

/**
 * Usado por /auth/refresh e /auth/logout. O refresh token vem no body (e não
 * em cookie httpOnly) para a API servir igualmente web e mobile; ver README
 * para o trade-off.
 */
export class RefreshTokenDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  @IsJWT()
  refreshToken: string;
}
