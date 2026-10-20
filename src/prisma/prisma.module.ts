import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

// @Global evita ter que importar PrismaModule em cada módulo de domínio.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
