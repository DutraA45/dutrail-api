import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class ExchangeCodeDto {
  @ApiProperty({
    description:
      'Código de uso único recebido na URL de redirect após o login com Google.',
    example: 'QmFzZTY0VXJsUmFuZG9tQ29kZS4uLg',
  })
  @IsString()
  // 32 bytes em base64url = 43 chars. Rejeitar tamanhos errados cedo evita
  // uma consulta ao banco por lixo.
  @Length(43, 43)
  code: string;
}
