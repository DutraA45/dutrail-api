import { Module } from '@nestjs/common';
import { SecurityLogService } from './security-log.service.js';

/**
 * Importado pelo AuthModule (fluxos de autenticação) e pelo AppModule (o
 * filtro global registra 429 e falhas do callback do Google).
 */
@Module({
  providers: [SecurityLogService],
  exports: [SecurityLogService],
})
export class SecurityLogModule {}
