import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ErrorResponseDto } from '../common/dto/error-response.dto.js';
import { ActivitiesService } from './activities.service.js';
import {
  ActivityPageDto,
  ActivityResponseDto,
} from './dto/activity-response.dto.js';
import { ListActivitiesQueryDto } from './dto/list-activities-query.dto.js';

/** Tamanho máximo do .fit aceito em POST /activities/import (10 MiB). */
export const FIT_FILE_MAX_BYTES = 10 * 1024 * 1024;

export const MISSING_FILE_MESSAGE = 'Envie um arquivo .fit no campo "file".';
export const EMPTY_FILE_MESSAGE = 'O arquivo .fit está vazio.';

/**
 * O parse do .fit roda no event loop (~1 s para um arquivo perto do limite) e
 * cada importação sobe um arquivo para o storage: limite próprio, abaixo do
 * global, para um cliente não monopolizar a API.
 */
const IMPORT_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/** O que o multer (armazenamento em memória, padrão do Nest) entrega. */
interface UploadedFitFile {
  buffer: Buffer;
  size: number;
}

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

  @Post('import')
  @Throttle(IMPORT_THROTTLE)
  @ApiOperation({
    summary: 'Cria uma atividade a partir de um arquivo .fit',
    description: `\`multipart/form-data\` com o arquivo no campo \`file\`, até ${FIT_FILE_MAX_BYTES} bytes (10 MiB). O arquivo original é guardado. Responde com a atividade criada, no mesmo formato de \`GET /activities/:id\`.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({ type: ActivityResponseDto })
  @ApiBadRequestResponse({
    description:
      'Arquivo ausente, vazio, inválido/corrompido ou que não é de uma atividade',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'O mesmo arquivo já foi importado por este usuário',
    type: ErrorResponseDto,
  })
  @ApiPayloadTooLargeResponse({
    description: 'Arquivo maior que 10 MiB',
    type: ErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Mais de 20 importações por minuto (por IP)',
    type: ErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'Falha ao guardar o arquivo; nada foi criado',
    type: ErrorResponseDto,
  })
  @UseInterceptors(
    FileInterceptor('file', {
      // Multer acima do limite → 413 (o Nest converte o LIMIT_FILE_SIZE).
      // Um único arquivo; qualquer outro campo de arquivo → 400.
      limits: { fileSize: FIT_FILE_MAX_BYTES, files: 1, fields: 10 },
    }),
  )
  async import(
    @CurrentUser() current: AuthenticatedUser,
    @UploadedFile() file: UploadedFitFile | undefined,
  ): Promise<ActivityResponseDto> {
    if (!file) {
      throw new BadRequestException(MISSING_FILE_MESSAGE);
    }
    if (file.size === 0) {
      throw new BadRequestException(EMPTY_FILE_MESSAGE);
    }
    // Dono sempre do token; campos de texto do formulário são ignorados.
    const activity = await this.activitiesService.importFitFile(
      current.userId,
      file.buffer,
    );
    return ActivityResponseDto.fromEntity(activity);
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
