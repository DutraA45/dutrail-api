import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto.js';
import type { AuthResult } from '../auth.service.js';
import type { TokenPair } from '../token.service.js';

const ACCESS_TOKEN_DESCRIPTION =
  'JWT de curta duração (15 min). Enviar em `Authorization: Bearer <token>`.';

const REFRESH_TOKEN_DESCRIPTION =
  'JWT de longa duração (7 dias), de uso único: cada /auth/refresh o invalida e devolve outro. ' +
  'Presente apenas quando X-Client-Type é `mobile` — no fluxo web ele vai no cookie httpOnly.';

/** Corpo de /auth/refresh para clientes **web** (o refresh vai no cookie). */
export class AccessTokenDto {
  @ApiProperty({ description: ACCESS_TOKEN_DESCRIPTION })
  accessToken: string;

  static fromTokens(tokens: TokenPair): AccessTokenDto {
    const dto = new AccessTokenDto();
    dto.accessToken = tokens.accessToken;
    return dto;
  }
}

/** Corpo de /auth/refresh para clientes **mobile**. */
export class TokenPairDto extends AccessTokenDto {
  @ApiProperty({ description: REFRESH_TOKEN_DESCRIPTION })
  refreshToken: string;

  static override fromTokens(tokens: TokenPair): TokenPairDto {
    const dto = new TokenPairDto();
    dto.accessToken = tokens.accessToken;
    dto.refreshToken = tokens.refreshToken;
    return dto;
  }
}

/** Corpo de signup/login/google-exchange para clientes **web**. */
export class AuthWebResponseDto extends AccessTokenDto {
  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;

  static fromResult(result: AuthResult): AuthWebResponseDto {
    const dto = new AuthWebResponseDto();
    dto.accessToken = result.accessToken;
    dto.user = UserResponseDto.fromEntity(result.user);
    return dto;
  }
}

/** Corpo de signup/login/google-exchange para clientes **mobile**. */
export class AuthMobileResponseDto extends TokenPairDto {
  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;

  static fromResult(result: AuthResult): AuthMobileResponseDto {
    const dto = new AuthMobileResponseDto();
    dto.accessToken = result.accessToken;
    dto.refreshToken = result.refreshToken;
    dto.user = UserResponseDto.fromEntity(result.user);
    return dto;
  }
}
