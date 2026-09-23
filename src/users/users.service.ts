import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { User } from '../generated/prisma/client.js';

export interface CreateUserInput {
  email: string;
  passwordHash?: string;
  name?: string;
  avatarUrl?: string;
  googleId?: string;
  emailVerified?: boolean;
}

/**
 * Acesso a dados de usuário. Não sabe nada de senha/token: isso é papel do
 * AuthModule. Mantê-lo "burro" facilita reutilizá-lo em outros módulos
 * (atividades, perfil...) sem arrastar dependências de autenticação.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Normaliza o email para que "Ana@X.com" e "ana@x.com" sejam a mesma conta. */
  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: UsersService.normalizeEmail(email) },
    });
  }

  findByGoogleId(googleId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { googleId } });
  }

  create(input: CreateUserInput): Promise<User> {
    return this.prisma.user.create({
      data: { ...input, email: UsersService.normalizeEmail(input.email) },
    });
  }

  /**
   * Vincula uma conta Google a um usuário existente (mesmo email).
   * O Google já verificou o email, então marcamos `emailVerified`.
   */
  linkGoogleAccount(
    userId: string,
    data: { googleId: string; name?: string; avatarUrl?: string },
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        googleId: data.googleId,
        emailVerified: true,
        // Só preenche nome/avatar se o usuário ainda não tinha.
        name: data.name === undefined ? undefined : { set: data.name },
        avatarUrl:
          data.avatarUrl === undefined ? undefined : { set: data.avatarUrl },
      },
    });
  }
}
