import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const DEFAULT_ACTIVITIES_LIMIT = 20;
export const MAX_ACTIVITIES_LIMIT = 100;

/** Query de GET /activities. Parâmetros desconhecidos dão 400 (pipe global). */
export class ListActivitiesQueryDto {
  @ApiPropertyOptional({
    description: 'Quantidade máxima de itens na página.',
    minimum: 1,
    maximum: MAX_ACTIVITIES_LIMIT,
    default: DEFAULT_ACTIVITIES_LIMIT,
  })
  @IsOptional()
  // Query string chega como texto; converte antes de validar.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ACTIVITIES_LIMIT)
  limit: number = DEFAULT_ACTIVITIES_LIMIT;

  @ApiPropertyOptional({
    description:
      'Valor opaco de `nextCursor` da página anterior. Omita para a primeira página.',
    example: 'WyIyMDI2LTA5LTIwVDA3OjE1OjMwLjAwMFoiLCJjN2EzZDJmNCJd',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
