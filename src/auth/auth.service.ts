import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SecurityContext } from '../security/security-context.js';
import { SecurityLogService } from '../security/security-log.service.js';
import { UsersService } from '../users/users.service.js';
import type { User } from '../generated/prisma/client.js';
import { GoogleEmailNotVerifiedException } from './google-callback.js';
import type { GoogleProfile } from './interfaces/google-profile.interface.js';
import { LoginAttemptsService } from './login-attempts.service.js';
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
    private readonly securityLog: SecurityLogService,
    private readonly loginAttempts: LoginAttemptsService,
  ) {}

  async signup(
    email: string,
    password: string,
    name: string | undefined,
    ctx: SecurityContext,
  ): Promise<AuthResult> {
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      // 409 explícito. Trade-off: revela que o email existe, mas o fluxo de
      // cadastro precisa disso para ser utilizável (o alternativo — "enviamos
      // um email" — exige infra de email, fora do escopo desta etapa). Por
      // isso fica no log: muitos 409 seguidos são enumeração de contas.
      this.securityLog.warn('signup_conflict', ctx, {
        userId: existing.id,
        email,
      });
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await this.passwordService.hash(password);
    const user = await this.usersService.create({ email, passwordHash, name });
    const tokens = await this.tokenService.issueTokenPair(user);
    this.securityLog.log('signup', ctx, { userId: user.id, email });
    return { ...tokens, user };
  }

  async login(
    email: string,
    password: string,
    ctx: SecurityContext,
  ): Promise<AuthResult> {
    // Limite por conta (A-03): conta a tentativa antes de qualquer consulta,
    // exista ou não a conta, e responde 429 se o limite já foi atingido.
    await this.loginAttempts.consume(email);

    const user = await this.usersService.findByEmail(email);

    // Conta inexistente OU conta só-Google (sem senha): mesma resposta.
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const passwordOk = await this.passwordService.verify(hashToCheck, password);

    if (!user || !user.passwordHash || !passwordOk) {
      // O motivo distingue os casos só no log; o cliente recebe o mesmo 401.
      // A tentativa já contada fica valendo como falha.
      this.securityLog.warn('login_failed', ctx, {
        userId: user?.id,
        email,
        reason: !user
          ? 'unknown_email'
          : !user.passwordHash
            ? 'no_password'
            : 'wrong_password',
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.loginAttempts.succeeded(email);
    const tokens = await this.tokenService.issueTokenPair(user);
    this.securityLog.log('login_success', ctx, { userId: user.id });
    return { ...tokens, user };
  }

  refresh(refreshToken: string, ctx: SecurityContext): Promise<TokenPair> {
    return this.tokenService.rotateRefreshToken(refreshToken, ctx);
  }

  logout(refreshToken: string, ctx: SecurityContext): Promise<void> {
    return this.tokenService.revokeRefreshToken(refreshToken, ctx);
  }

  /**
   * "Sair de todos os dispositivos" (A-08): apaga, numa transação, todos os
   * refresh tokens do usuário (todas as famílias) e os códigos de troca do
   * Google pendentes. Idempotente: sem sessões, não há o que apagar.
   *
   * Apagar, e não marcar `revokedAt`, pelo mesmo motivo do logout e do A-01:
   * uma linha só marcada ainda passaria pela janela de tolerância (e ganharia
   * um par novo) ou pela detecção de reuso. Apagada, qualquer token
   * reapresentado é "não encontrado" (401 simples).
   *
   * Os access tokens já emitidos continuam válidos até expirar (stateless).
   */
  async logoutAll(userId: string, ctx: SecurityContext): Promise<void> {
    const sessionsRemoved = await this.prisma.$transaction(async (tx) => {
      // Contadas antes do DELETE, só para o log: um login concorrente pode
      // ser apagado sem entrar na contagem.
      const families = await tx.refreshToken.findMany({
        where: { userId },
        distinct: ['familyId'],
        select: { familyId: true },
      });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.oAuthExchangeCode.deleteMany({ where: { userId } });
      return families.length;
    });
    this.securityLog.log('logout_all', ctx, { userId, sessionsRemoved });
  }

  /**
   * Chamado pela GoogleStrategy após o Google confirmar a identidade.
   *
   * 1. Já existe usuário com este googleId  -> login.
   * 2. Existe usuário com o mesmo email     -> vincula a conta Google a ele
   *    (se o email dele não era verificado, descarta senha e sessões).
   * 3. Não existe                           -> cria usuário sem senha.
   */
  async loginWithGoogle(
    profile: GoogleProfile,
    ctx: SecurityContext,
  ): Promise<User> {
    const byGoogleId = await this.usersService.findByGoogleId(profile.googleId);
    if (byGoogleId) {
      return byGoogleId;
    }

    // Só vinculamos se o Google garante que o email pertence a essa pessoa.
    // Caso contrário alguém poderia criar uma conta Google com o email de
    // outra pessoa e sequestrar a conta local dela.
    if (!profile.emailVerified) {
      throw new GoogleEmailNotVerifiedException();
    }

    const byEmail = await this.usersService.findByEmail(profile.email);
    if (byEmail) {
      const data = {
        googleId: profile.googleId,
        name: byEmail.name ?? profile.name,
        avatarUrl: byEmail.avatarUrl ?? profile.avatarUrl,
      };
      if (byEmail.emailVerified) {
        const linked = await this.usersService.linkGoogleAccount(
          byEmail.id,
          data,
        );
        this.securityLog.log('google_link', ctx, {
          userId: byEmail.id,
          reason: 'verified_account',
        });
        return linked;
      }
      // warn: legítimo para o dono do email, mas também é o desfecho de uma
      // tentativa de pre-hijacking (senha e sessões anteriores descartadas).
      const linked = await this.takeOverUnverifiedAccount(byEmail.id, data);
      this.securityLog.warn('google_link', ctx, {
        userId: byEmail.id,
        reason: 'unverified_takeover',
      });
      return linked;
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
   * Vincula o Google a uma conta local cujo email nunca foi verificado.
   *
   * Nada garante que quem fez o signup era o dono do email (account
   * pre-hijacking: alguém cadastra o email da vítima com uma senha própria e
   * espera ela entrar com Google). O Google acabou de provar quem é o dono,
   * então tudo que veio antes é descartado: a senha e as sessões (refresh
   * tokens e códigos de troca pendentes). Numa transação só, para que a conta
   * nunca fique vinculada com a credencial antiga ainda valendo.
   *
   * Os refresh tokens são apagados, não marcados com `revokedAt`: apagado, um
   * token reapresentado é só "não encontrado" (401 simples), sem passar pela
   * janela de tolerância (que emitiria um par novo) nem pela detecção de
   * reuso.
   */
  private takeOverUnverifiedAccount(
    userId: string,
    data: { googleId: string; name?: string; avatarUrl?: string },
  ): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.oAuthExchangeCode.deleteMany({ where: { userId } });
      return this.usersService.linkGoogleAccount(
        userId,
        { ...data, discardPassword: true },
        tx,
      );
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
  async exchangeCode(code: string, ctx: SecurityContext): Promise<AuthResult> {
    const codeHash = AuthService.hashCode(code);
    const stored = await this.prisma.oAuthExchangeCode.findUnique({
      where: { codeHash },
      include: { user: true },
    });

    const invalidReason = !stored
      ? 'not_found'
      : stored.usedAt
        ? 'used'
        : stored.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : undefined;
    if (!stored || invalidReason) {
      this.securityLog.warn('google_exchange_failed', ctx, {
        userId: stored?.user.id,
        reason: invalidReason,
      });
      throw new UnauthorizedException('Invalid or expired code');
    }

    // Mesmo padrão compare-and-set do refresh token: só o primeiro request
    // concorrente consegue marcar o código como usado.
    const { count } = await this.prisma.oAuthExchangeCode.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count === 0) {
      this.securityLog.warn('google_exchange_failed', ctx, {
        userId: stored.user.id,
        reason: 'concurrent_use',
      });
      throw new UnauthorizedException('Invalid or expired code');
    }

    const tokens = await this.tokenService.issueTokenPair(stored.user);
    this.securityLog.log('google_exchange_success', ctx, {
      userId: stored.user.id,
    });
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
