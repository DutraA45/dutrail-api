import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  // Exportado para o AuthModule poder criar/buscar usuários.
  exports: [UsersService],
})
export class UsersModule {}
