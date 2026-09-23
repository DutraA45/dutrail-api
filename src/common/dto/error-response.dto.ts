import { ApiProperty } from '@nestjs/swagger';

/**
 * Formato único de erro da API, produzido pelo AllExceptionsFilter.
 * Usado no Swagger para documentar as respostas 4xx/5xx.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: 'Bad Request' })
  error: string;

  @ApiProperty({
    description: 'Mensagem única ou lista de mensagens (erros de validação).',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['email must be an email'],
  })
  message: string | string[];

  @ApiProperty({ example: '/auth/login' })
  path: string;

  @ApiProperty({ example: '2026-09-21T12:00:00.000Z' })
  timestamp: string;
}
