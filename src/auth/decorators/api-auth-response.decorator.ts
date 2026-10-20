import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import {
  AccessTokenDto,
  AuthMobileResponseDto,
  AuthWebResponseDto,
  TokenPairDto,
} from '../dto/auth-response.dto.js';

const WEB_NOTE =
  '`web`: refreshToken **não** vem no corpo — vai no cookie httpOnly `refreshToken`.';
const MOBILE_NOTE =
  '`mobile`: refreshToken vem no corpo, sem nenhum `Set-Cookie`.';

/**
 * Documenta uma resposta cujo corpo depende do X-Client-Type. O `oneOf` faz o
 * Swagger mostrar os dois formatos possíveis em vez de um só, que estaria
 * errado para metade dos clientes.
 */
export const ApiAuthResponse = (status: number) =>
  applyDecorators(
    ApiExtraModels(AuthWebResponseDto, AuthMobileResponseDto),
    ApiResponse({
      status,
      description: `Tokens emitidos. ${WEB_NOTE} ${MOBILE_NOTE}`,
      schema: {
        oneOf: [
          { $ref: getSchemaPath(AuthWebResponseDto) },
          { $ref: getSchemaPath(AuthMobileResponseDto) },
        ],
      },
    }),
  );

/** Idem, para /auth/refresh (que não devolve o usuário). */
export const ApiRefreshResponse = () =>
  applyDecorators(
    ApiExtraModels(AccessTokenDto, TokenPairDto),
    ApiResponse({
      status: 200,
      description: `Novo par de tokens. ${WEB_NOTE} ${MOBILE_NOTE}`,
      schema: {
        oneOf: [
          { $ref: getSchemaPath(AccessTokenDto) },
          { $ref: getSchemaPath(TokenPairDto) },
        ],
      },
    }),
  );
