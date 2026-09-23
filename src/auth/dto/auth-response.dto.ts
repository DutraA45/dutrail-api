import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto.js';
import type { AuthResult } from '../auth.service.js';
import type { TokenPair } from '../token.service.js';

export class TokenPairDto {
  @ApiProperty({
    description:
      'JWT de curta duração. Enviar em `Authorization: Bearer <token>`.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken: string;

  @ApiProperty({
    description:
      'JWT de longa duração, de uso único: cada chamada a /auth/refresh o invalida e devolve outro.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  refreshToken: string;

  static fromTokens(tokens: TokenPair): TokenPairDto {
    const dto = new TokenPairDto();
    dto.accessToken = tokens.accessToken;
    dto.refreshToken = tokens.refreshToken;
    return dto;
  }
}

export class AuthResponseDto extends TokenPairDto {
  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;

  static fromResult(result: AuthResult): AuthResponseDto {
    const dto = new AuthResponseDto();
    dto.accessToken = result.accessToken;
    dto.refreshToken = result.refreshToken;
    dto.user = UserResponseDto.fromEntity(result.user);
    return dto;
  }
}
