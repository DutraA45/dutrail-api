import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { User } from '../../generated/prisma/client.js';

/**
 * Representação pública de um usuário. É o ÚNICO formato de usuário que sai
 * da API: `passwordHash`, `googleId` e afins nunca aparecem aqui.
 */
export class UserResponseDto {
  @ApiProperty({ example: 'c7a3d2f4-8b1e-4c7a-9f3d-2e1b5a6c8d9e' })
  id: string;

  @ApiProperty({ example: 'ana@example.com' })
  email: string;

  @ApiPropertyOptional({ example: 'Ana Silva', nullable: true })
  name: string | null;

  @ApiPropertyOptional({
    example: 'https://lh3.googleusercontent.com/a/...',
    nullable: true,
  })
  avatarUrl: string | null;

  @ApiProperty({ example: true })
  emailVerified: boolean;

  @ApiProperty({
    description:
      'Indica se a conta tem senha (false para contas criadas só via Google).',
    example: true,
  })
  hasPassword: boolean;

  @ApiProperty({ example: '2026-09-21T12:00:00.000Z' })
  createdAt: Date;

  /**
   * Mapeamento explícito (whitelist) em vez de `@Exclude` no entity: um campo
   * novo na tabela só é exposto se alguém escrever isso aqui de propósito.
   */
  static fromEntity(user: User): UserResponseDto {
    const dto = new UserResponseDto();
    dto.id = user.id;
    dto.email = user.email;
    dto.name = user.name;
    dto.avatarUrl = user.avatarUrl;
    dto.emailVerified = user.emailVerified;
    dto.hasPassword = user.passwordHash !== null;
    dto.createdAt = user.createdAt;
    return dto;
  }
}
