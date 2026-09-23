import { Controller, Get, NotFoundException } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ErrorResponseDto } from '../common/dto/error-response.dto.js';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { UserResponseDto } from './dto/user-response.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * Rota protegida de exemplo. Não há @UseGuards aqui porque o JwtAuthGuard
   * é global: sem Bearer válido a request nem chega neste método.
   */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Retorna o usuário autenticado' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Access token ausente, inválido ou expirado',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Usuário do token não existe mais',
    type: ErrorResponseDto,
  })
  async me(
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.findById(current.userId);
    if (!user) {
      // Token válido mas usuário apagado após a emissão.
      throw new NotFoundException('User not found');
    }
    return UserResponseDto.fromEntity(user);
  }
}
