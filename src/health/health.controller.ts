import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator.js';
import { HealthResponseDto } from './dto/health-response.dto.js';

/**
 * Liveness para o proxy e o monitoramento: responde se o processo está de pé e
 * atendendo HTTP. Não consulta o banco nem o storage de propósito, para uma
 * instabilidade do Postgres não derrubar a API do balanceamento nem gerar
 * carga no banco a cada checagem.
 *
 * Público e fora do rate limit: o monitor bate com frequência fixa, às vezes
 * do mesmo IP do proxy, e não pode consumir (nem esgotar) o limite global.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({
    summary: 'Health check (liveness)',
    description:
      'Sem autenticação e sem rate limit. Não consulta o banco: indica só que a API está atendendo.',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  check(): HealthResponseDto {
    return { status: 'ok' };
  }
}
