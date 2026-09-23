import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import type { User } from '../generated/prisma/client.js';
import type { GoogleProfile } from './interfaces/google-profile.interface.js';
import { PasswordService } from './password.service.js';
import { TokenService, type TokenPair } from './token.service.js';

export interface AuthResult extends TokenPair {
  user: User;
}

/** Validade do código de troca gerado no callback do Google. */
const EXCHANGE_CODE_TTL_MS = 60_000;

/**
 * Casos de uso de autenticação. Orquestra UsersService (dados), PasswordService
 * (hash) e TokenService (JWT/refresh). Não conhece HTTP: quem traduz para
 * status/DTOs é o AuthController.
 */
@Injectable()
export class AuthService {
  // Hash de uma senha qualquer, usado para gastar o mesmo tempo de argon2
  // quando o email não existe. Sem isso, a diferença de tempo entre
  // "email não existe" (resposta imediata) e "senha errada" (argon2 lento)
  // permitiria enumerar emails cadastrados.
  private dummyHashPromise?: Promise<string>;

  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async signup(
    email: string,
    password: string,
    name?: string,
  ): Promise<AuthResult> {
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      // 409 explícito. Trade-off: revela que o email existe, mas o fluxo de
      // cadastro precisa disso para ser utilizável (o alternativo — "enviamos
      // um email" — exige infra de email, fora do escopo desta etapa).
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await this.passwordService.hash(password);
    const user = await this.usersService.create({ email, passwordHash, name });
    const tokens = await this.tokenService.issueTokenPair(user);
    return { ...tokens, user };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.usersService.findByEmail(email);

    // Conta inexistente OU conta só-Google (sem senha): mesma resposta.
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const passwordOk = await this.passwordService.verify(hashToCheck, password);

    if (!user || !user.passwordHash || !passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.tokenService.issueTokenPair(user);
    return { ...tokens, user };
  }

  refresh(refreshToken: string): Promise<TokenPair> {
    return this.tokenService.rotateRefreshToken(refreshToken);
  }

  logout(refreshToken: string): Promise<void> {
    return this.tokenService.revokeRefreshToken(refreshToken);
  }

  /**
   * Chamado pela GoogleStrategy após o Google confirmar a identidade.
   *
   * 1. Já existe usuário com este googleId  -> login.
   * 2. Existe usuário com o mesmo email     -> vincula a conta Google a ele.
   * 3. Não existe                           -> cria usuário sem senha.
   */
  async loginWithGoogle(profile: GoogleProfile): Promise<User> {
    const byGoogleId = await this.usersService.findByGoogleId(profile.googleId);
    if (byGoogleId) {
      return byGoogleId;
    }

    // Só vinculamos se o Google garante que o email pertence a essa pessoa.
    // Caso contrário alguém poderia criar uma conta Google com o email de
    // outra pessoa e sequestrar a conta local dela.
    if (!profile.emailVerified) {
      throw new UnauthorizedException('Google account email is not verified');
    }

    const byEmail = await this.usersService.findByEmail(profile.email);
    if (byEmail) {
      return this.usersService.linkGoogleAccount(byEmail.id, {
        googleId: profile.googleId,
        name: byEmail.name ?? profile.name,
        avatarUrl: byEmail.avatarUrl ?? profile.avatarUrl,
      });
    }

    return this.usersService.create({
      email: profile.email,
      googleId: profile.googleId,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      emailVerified: true,
    });
  }

  /**
   * Gera o código de uso único que o callback do Google coloca na URL de
   * redirect. Persistimos só o hash, pelo mesmo motivo do refresh token.
   */
  async createExchangeCode(userId: string): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    await this.prisma.oAuthExchangeCode.create({
      data: {
        codeHash: AuthService.hashCode(code),
        userId,
        expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_MS),
      },
    });
    return code;
  }

  /** Troca o código de uso único por um par de tokens (POST /auth/google/exchange). */
  async exchangeCode(code: string): Promise<AuthResult> {
    const codeHash = AuthService.hashCode(code);
    const stored = await this.prisma.oAuthExchangeCode.findUnique({
      where: { codeHash },
      include: { user: true },
    });

    if (!stored || stored.usedAt || stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    // Mesmo padrão compare-and-set do refresh token: só o primeiro request
    // concorrente consegue marcar o código como usado.
    const { count } = await this.prisma.oAuthExchangeCode.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count === 0) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    const tokens = await this.tokenService.issueTokenPair(stored.user);
    return { ...tokens, user: stored.user };
  }

  private static hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private getDummyHash(): Promise<string> {
    // Calculado uma vez (lazy) e reaproveitado: argon2 é caro de propósito.
    this.dummyHashPromise ??= this.passwordService.hash(
      randomBytes(16).toString('hex'),
    );
    return this.dummyHashPromise;
  }
}
