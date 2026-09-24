import { ApiProperty } from '@nestjs/swagger';
import { ActivitySport, type Activity } from '../../generated/prisma/client.js';

/** Formato público de uma atividade. Igual na listagem e no detalhe. */
export class ActivityResponseDto {
  @ApiProperty({ example: '0b8e6f2a-3c1d-4e5f-9a7b-1c2d3e4f5a6b' })
  id: string;

  @ApiProperty({
    description: 'Dono da atividade (sempre o usuário do token).',
    example: 'c7a3d2f4-8b1e-4c7a-9f3d-2e1b5a6c8d9e',
  })
  userId: string;

  @ApiProperty({ example: 'Corrida matinal' })
  name: string;

  @ApiProperty({
    enum: ActivitySport,
    enumName: 'ActivitySport',
    example: ActivitySport.running,
  })
  sport: ActivitySport;

  @ApiProperty({
    description: 'Início da atividade (UTC, ISO 8601).',
    example: '2026-09-20T07:15:30.000Z',
  })
  startedAt: Date;

  @ApiProperty({
    description: 'Tempo total em segundos, pausas incluídas.',
    example: 3125,
  })
  elapsedTimeSeconds: number;

  @ApiProperty({
    description: 'Tempo em movimento, em segundos.',
    example: 3010,
    nullable: true,
    type: Number,
  })
  movingTimeSeconds: number | null;

  @ApiProperty({ example: 10012.4, nullable: true, type: Number })
  distanceMeters: number | null;

  @ApiProperty({ example: 87.2, nullable: true, type: Number })
  elevationGainMeters: number | null;

  @ApiProperty({ example: 152, nullable: true, type: Number })
  averageHeartRateBpm: number | null;

  @ApiProperty({ example: 178, nullable: true, type: Number })
  maxHeartRateBpm: number | null;

  @ApiProperty({
    description: 'Quilocalorias (kcal).',
    example: 689,
    nullable: true,
    type: Number,
  })
  calories: number | null;

  @ApiProperty({
    description: 'Quando a atividade foi registrada no Dutrail.',
    example: '2026-09-20T08:30:02.114Z',
  })
  createdAt: Date;

  @ApiProperty({ example: '2026-09-20T08:30:02.114Z' })
  updatedAt: Date;

  /** Mapeamento explícito, como em UserResponseDto: nada vaza por acidente. */
  static fromEntity(activity: Activity): ActivityResponseDto {
    const dto = new ActivityResponseDto();
    dto.id = activity.id;
    dto.userId = activity.userId;
    dto.name = activity.name;
    dto.sport = activity.sport;
    dto.startedAt = activity.startedAt;
    dto.elapsedTimeSeconds = activity.elapsedTimeSeconds;
    dto.movingTimeSeconds = activity.movingTimeSeconds;
    dto.distanceMeters = activity.distanceMeters;
    dto.elevationGainMeters = activity.elevationGainMeters;
    dto.averageHeartRateBpm = activity.averageHeartRateBpm;
    dto.maxHeartRateBpm = activity.maxHeartRateBpm;
    dto.calories = activity.calories;
    dto.createdAt = activity.createdAt;
    dto.updatedAt = activity.updatedAt;
    return dto;
  }
}

/** Página de GET /activities. */
export class ActivityPageDto {
  @ApiProperty({ type: [ActivityResponseDto] })
  items: ActivityResponseDto[];

  @ApiProperty({
    description:
      'Cursor para a próxima página (`?cursor=`). `null` quando não há mais itens.',
    example: 'WyIyMDI2LTA5LTIwVDA3OjE1OjMwLjAwMFoiLCJjN2EzZDJmNCJd',
    nullable: true,
    type: String,
  })
  nextCursor: string | null;
}
