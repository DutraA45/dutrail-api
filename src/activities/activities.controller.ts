import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ErrorResponseDto } from '../common/dto/error-response.dto.js';
import { ActivitiesService } from './activities.service.js';
import {
  ActivityPageDto,
  ActivityResponseDto,
} from './dto/activity-response.dto.js';
import { ListActivitiesQueryDto } from './dto/list-activities-query.dto.js';

/**
 * Rotas protegidas pelo JwtAuthGuard global. O dono é sempre o usuário do
 * token (`@CurrentUser()`), nunca um parâmetro da request.
 */
@ApiTags('activities')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'Access token ausente, inválido ou expirado',
  type: ErrorResponseDto,
})
@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista as atividades do usuário autenticado',
    description:
      'Mais recentes primeiro (`startedAt` decrescente), paginado por cursor.',
  })
  @ApiOkResponse({ type: ActivityPageDto })
  @ApiBadRequestResponse({
    description:
      '`limit` fora de 1..100, `cursor` inválido ou parâmetro desconhecido',
    type: ErrorResponseDto,
  })
  async list(
    @CurrentUser() current: AuthenticatedUser,
    @Query() query: ListActivitiesQueryDto,
  ): Promise<ActivityPageDto> {
    const page = await this.activitiesService.listForUser(current.userId, {
      limit: query.limit,
      cursor: query.cursor,
    });
    return {
      items: page.items.map((a) => ActivityResponseDto.fromEntity(a)),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe de uma atividade do usuário autenticado' })
  @ApiOkResponse({ type: ActivityResponseDto })
  @ApiNotFoundResponse({
    description:
      'Atividade inexistente **ou de outro usuário** — mesma resposta nos dois casos',
    type: ErrorResponseDto,
  })
  async findOne(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ActivityResponseDto> {
    const activity = await this.activitiesService.findForUser(
      current.userId,
      id,
    );
    if (!activity) {
      // 404 (não 403) também quando a atividade é de outro usuário: 403
      // confirmaria que o id existe.
      throw new NotFoundException('Activity not found');
    }
    return ActivityResponseDto.fromEntity(activity);
  }
}
