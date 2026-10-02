import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SecurityContext } from '../security/security-context.js';
import { SecurityLogService } from '../security/security-log.service.js';
import { UsersService } from '../users/users.service.js';
import type { User } from '../generated/prisma/client.js';
import { AuthService, BREACHED_PASSWORD_MESSAGE } from './auth.service.js';
import { BreachedPasswordService } from './breached-password.service.js';
import { AuthService } from './auth.service.js';
import {
  AccountLoginLimitException,
  LoginAttemptsService,
} from './login-attempts.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

const tokens = { accessToken: 'access', refreshToken: 'refresh' };
const MATCH = { valid: true, needsRehash: false };
const LEGACY_MATCH = { valid: true, needsRehash: true };
const MISMATCH = { valid: false };
const ctx: SecurityContext = {
  ip: '203.0.113.7',
  userAgent: 'vitest',
  clientType: 'mobile',
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'ana@example.com',
    passwordHash: 'hash-da-senha',
    name: 'Ana',
    avatarUrl: null,
    googleId: null,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let users: {
    findByEmail: any;
    findByGoogleId: any;
    create: any;
    linkGoogleAccount: any;
  };
  let password: { hash: any; verify: any };
  let tokenService: {
    issueTokenPair: any;
    rotateRefreshToken: any;
    revokeRefreshToken: any;
  };
  let prisma: {
    user: { updateMany: any };
    oAuthExchangeCode: { create: any; findUnique: any; updateMany: any };
    $transaction: any;
  };
  let tx: {
    refreshToken: { findMany: any; deleteMany: any };
    oAuthExchangeCode: { deleteMany: any };
  };
  let securityLog: { log: any; warn: any };
  let breached: { check: any };
  let loginAttempts: { consume: any; succeeded: any };

  beforeEach(async () => {
    users = {
      findByEmail: vi.fn(),
      findByGoogleId: vi.fn(),
      create: vi.fn(),
      linkGoogleAccount: vi.fn(),
    };
    password = {
      hash: vi.fn().mockResolvedValue('hash-da-senha'),
      verify: vi.fn(),
    };
    tokenService = {
      issueTokenPair: vi.fn().mockResolvedValue(tokens),
      rotateRefreshToken: vi.fn(),
      revokeRefreshToken: vi.fn(),
    };
    prisma = {
      user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      oAuthExchangeCode: {
        create: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      // Roda o callback com um cliente de transação falso.
      $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    tx = {
      refreshToken: { findMany: vi.fn(), deleteMany: vi.fn() },
      oAuthExchangeCode: { deleteMany: vi.fn() },
    };
    securityLog = { log: vi.fn(), warn: vi.fn() };
    breached = { check: vi.fn().mockResolvedValue('clean') };
    loginAttempts = {
      consume: vi.fn().mockResolvedValue(undefined),
      succeeded: vi.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: PasswordService, useValue: password },
        { provide: TokenService, useValue: tokenService },
        { provide: PrismaService, useValue: prisma },
        { provide: SecurityLogService, useValue: securityLog },
        { provide: BreachedPasswordService, useValue: breached },
        { provide: LoginAttemptsService, useValue: loginAttempts },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('signup', () => {
    it('cria o usuário com a senha hasheada e devolve tokens', async () => {
      users.findByEmail.mockResolvedValue(null);
      const created = makeUser();
      users.create.mockResolvedValue(created);

      const result = await service.signup(
        'ana@example.com',
        'S3nh@Forte!',
        'Ana',
        ctx,
      );

      expect(password.hash).toHaveBeenCalledWith('S3nh@Forte!');
      expect(users.create).toHaveBeenCalledWith({
        email: 'ana@example.com',
        passwordHash: 'hash-da-senha',
        name: 'Ana',
      });
      // A senha em texto puro nunca chega ao repositório.
      expect(JSON.stringify(users.create.mock.calls)).not.toContain(
        'S3nh@Forte!',
      );
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(created);
      expect(result).toEqual({ ...tokens, user: created });
      // O email vai em claro para o serviço de log, que é quem mascara.
      expect(securityLog.log).toHaveBeenCalledWith('signup', ctx, {
        userId: 'user-1',
        email: 'ana@example.com',
      });
    });

    it('rejeita email já cadastrado com 409', async () => {
      users.findByEmail.mockResolvedValue(makeUser());

      await expect(
        service.signup('ana@example.com', 'S3nh@Forte!', undefined, ctx),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(users.create).not.toHaveBeenCalled();
      // Nada vai à rede para um cadastro que já seria recusado.
      expect(breached.check).not.toHaveBeenCalled();
    });

    it('consulta a senha recebida na lista de vazadas antes do hash', async () => {
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser());

      await service.signup('ana@example.com', 'S3nh@Forte!', undefined, ctx);

      expect(breached.check).toHaveBeenCalledWith('S3nh@Forte!');
      expect(breached.check.mock.invocationCallOrder[0]).toBeLessThan(
        password.hash.mock.invocationCallOrder[0],
      );
      expect(securityLog.warn).not.toHaveBeenCalled();
    });

    it('rejeita com 400 a senha vazada, sem hash nem usuário, e registra o motivo', async () => {
      users.findByEmail.mockResolvedValue(null);
      breached.check.mockResolvedValue('breached');

      const err: unknown = await service
        .signup('ana@example.com', 'password123', undefined, ctx)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        message: [BREACHED_PASSWORD_MESSAGE],
      });
      expect(password.hash).not.toHaveBeenCalled();
      expect(users.create).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith('signup_rejected', ctx, {
        email: 'ana@example.com',
        reason: 'breached_password',
      });
    });

    it.each([
      ['timeout', 'timeout'],
      ['error', 'check_error'],
    ] as const)(
      'API de vazadas indisponível (%s): o cadastro segue, com warn no log',
      async (result, reason) => {
        users.findByEmail.mockResolvedValue(null);
        users.create.mockResolvedValue(makeUser());
        breached.check.mockResolvedValue(result);

        await expect(
          service.signup('ana@example.com', 'S3nh@Forte!', undefined, ctx),
        ).resolves.toMatchObject({ user: { id: 'user-1' } });
        expect(securityLog.warn).toHaveBeenCalledWith(
          'breach_check_unavailable',
          ctx,
          { reason },
        );
      },
    );

    it('checagem desligada: o cadastro segue sem log', async () => {
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser());
      breached.check.mockResolvedValue('disabled');

      await service.signup('ana@example.com', 'S3nh@Forte!', undefined, ctx);

      expect(users.create).toHaveBeenCalled();
      expect(securityLog.warn).not.toHaveBeenCalled();
    });

    it('rejeita com 400 a senha que passa de 128 caracteres depois do NFKC (A-09)', async () => {
      // 64 caracteres na entrada (cabe no DTO); "㍿" vira "株式会社" no NFKC.
      const expands = '㍿'.repeat(64);
      expect(expands.normalize('NFKC')).toHaveLength(256);

      const err: unknown = await service
        .signup('ana@example.com', expands, undefined, ctx)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        message: [expect.stringContaining('after Unicode normalization')],
      });
      expect(users.findByEmail).not.toHaveBeenCalled();
      expect(breached.check).not.toHaveBeenCalled();
      expect(password.hash).not.toHaveBeenCalled();
    });

    it('aceita exatamente 128 caracteres depois do NFKC', async () => {
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser());

      await service.signup('ana@example.com', '㍿'.repeat(32), undefined, ctx);

      expect(password.hash).toHaveBeenCalledWith('㍿'.repeat(32));
      // Sem texto livre: só o userId da conta existente e o email (mascarado
      // pelo serviço de log).
      expect(securityLog.warn).toHaveBeenCalledWith('signup_conflict', ctx, {
        userId: 'user-1',
        email: 'ana@example.com',
      });
    });
  });

  describe('login', () => {
    it('devolve tokens quando a senha confere', async () => {
      const user = makeUser();
      users.findByEmail.mockResolvedValue(user);
      password.verify.mockResolvedValue(MATCH);

      const result = await service.login('ana@example.com', 'S3nh@Forte!', ctx);

      expect(password.verify).toHaveBeenCalledWith(
        'hash-da-senha',
        'S3nh@Forte!',
      );
      expect(result).toEqual({ ...tokens, user });
      expect(securityLog.log).toHaveBeenCalledWith('login_success', ctx, {
        userId: 'user-1',
      });
      // A lista de vazadas só é consultada quando a senha é definida.
      expect(breached.check).not.toHaveBeenCalled();
      expect(loginAttempts.consume).toHaveBeenCalledWith('ana@example.com');
      expect(loginAttempts.succeeded).toHaveBeenCalledWith('ana@example.com');
    });

    it('com o limite por conta atingido, responde 429 sem consultar a conta nem a senha', async () => {
      loginAttempts.consume.mockRejectedValue(
        new AccountLoginLimitException(60),
      );

      await expect(
        service.login('ana@example.com', 'S3nh@Forte!', ctx),
      ).rejects.toBeInstanceOf(AccountLoginLimitException);
      expect(users.findByEmail).not.toHaveBeenCalled();
      expect(password.verify).not.toHaveBeenCalled();
      expect(loginAttempts.succeeded).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejeita senha errada com 401 genérico', async () => {
      users.findByEmail.mockResolvedValue(makeUser());
      password.verify.mockResolvedValue(MISMATCH);

      await expect(
        service.login('ana@example.com', 'errada', ctx),
      ).rejects.toThrow('Invalid credentials');
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
      // A falha não zera a contagem por conta.
      expect(loginAttempts.consume).toHaveBeenCalledWith('ana@example.com');
      expect(loginAttempts.succeeded).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith('login_failed', ctx, {
        userId: 'user-1',
        email: 'ana@example.com',
        reason: 'wrong_password',
      });
    });

    it('rejeita email desconhecido com o MESMO 401, ainda gastando tempo de hash', async () => {
      users.findByEmail.mockResolvedValue(null);
      password.verify.mockResolvedValue(MISMATCH);

      await expect(
        service.login('ninguem@example.com', 'x', ctx),
      ).rejects.toThrow('Invalid credentials');
      // Email inexistente conta do mesmo jeito (não revela a existência).
      expect(loginAttempts.consume).toHaveBeenCalledWith('ninguem@example.com');
      expect(loginAttempts.succeeded).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith('login_failed', ctx, {
        userId: undefined,
        email: 'ninguem@example.com',
        reason: 'unknown_email',
      });
      // Verificação contra um hash "dummy": evita revelar por timing que o
      // email não existe.
      expect(password.hash).toHaveBeenCalledTimes(1);
      expect(password.verify).toHaveBeenCalledTimes(1);
    });

    it('hash legado (senha bruta, sem NFKC): entra e troca pelo hash da forma normalizada', async () => {
      const user = makeUser({ passwordHash: 'hash-legado' });
      users.findByEmail.mockResolvedValue(user);
      password.verify.mockResolvedValue(LEGACY_MATCH);
      password.hash.mockResolvedValue('hash-normalizado');

      const result = await service.login('ana@example.com', 'cafe\u0301!', ctx);

      expect(result).toEqual({ ...tokens, user });
      // O PasswordService normaliza dentro do hash().
      expect(password.hash).toHaveBeenCalledWith('cafe\u0301!');
      // Compare-and-set no hash antigo: não ressuscita senha descartada.
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'user-1', passwordHash: 'hash-legado' },
        data: { passwordHash: 'hash-normalizado' },
      });
    });

    it('não refaz o hash quando a senha bate na forma normalizada', async () => {
      users.findByEmail.mockResolvedValue(makeUser());
      password.verify.mockResolvedValue(MATCH);

      await service.login('ana@example.com', 'S3nh@Forte!', ctx);

      expect(password.hash).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('email desconhecido passa a senha recebida pelo mesmo verify da senha errada', async () => {
      // O verify decide sozinho se tenta também a senha bruta, pela senha
      // recebida; chamado igual nos dois caminhos, o custo é o mesmo.
      password.verify.mockResolvedValue(MISMATCH);
      users.findByEmail.mockResolvedValueOnce(makeUser());
      await expect(
        service.login('ana@example.com', 'cafe\u0301!', ctx),
      ).rejects.toThrow('Invalid credentials');
      users.findByEmail.mockResolvedValueOnce(null);
      await expect(
        service.login('ninguem@example.com', 'cafe\u0301!', ctx),
      ).rejects.toThrow('Invalid credentials');

      expect(password.verify).toHaveBeenNthCalledWith(
        1,
        'hash-da-senha',
        'cafe\u0301!',
      );
      expect(password.verify).toHaveBeenNthCalledWith(
        2,
        'hash-da-senha', // o mock do hash() também gera o dummy
        'cafe\u0301!',
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('rejeita login por senha em conta só-Google (sem passwordHash)', async () => {
      users.findByEmail.mockResolvedValue(
        makeUser({ passwordHash: null, googleId: 'g-1' }),
      );
      // Mesmo que o verify "passasse" (não passa: é o hash dummy), a ausência
      // de senha tem que bloquear.
      password.verify.mockResolvedValue(MATCH);

      await expect(
        service.login('ana@example.com', 'qualquer', ctx),
      ).rejects.toThrow('Invalid credentials');
      expect(securityLog.warn).toHaveBeenCalledWith(
        'login_failed',
        ctx,
        expect.objectContaining({ reason: 'no_password' }),
      );
    });
  });

  describe('loginWithGoogle', () => {
    const profile = {
      googleId: 'g-123',
      email: 'ana@example.com',
      emailVerified: true,
      name: 'Ana Google',
      avatarUrl: 'https://img/ana.png',
    };

    it('faz login direto quando o googleId já está vinculado', async () => {
      const user = makeUser({ googleId: 'g-123' });
      users.findByGoogleId.mockResolvedValue(user);

      await expect(service.loginWithGoogle(profile, ctx)).resolves.toBe(user);
      expect(users.findByEmail).not.toHaveBeenCalled();
      expect(users.create).not.toHaveBeenCalled();
    });

    it('vincula a conta Google a um usuário verificado mantendo a senha', async () => {
      users.findByGoogleId.mockResolvedValue(null);
      const existing = makeUser({
        name: 'Ana',
        avatarUrl: null,
        emailVerified: true,
      });
      users.findByEmail.mockResolvedValue(existing);
      const linked = makeUser({ googleId: 'g-123', emailVerified: true });
      users.linkGoogleAccount.mockResolvedValue(linked);

      await expect(service.loginWithGoogle(profile, ctx)).resolves.toBe(linked);
      // Mantém o nome que o usuário já tinha; preenche só o que faltava.
      expect(users.linkGoogleAccount).toHaveBeenCalledWith('user-1', {
        googleId: 'g-123',
        name: 'Ana',
        avatarUrl: 'https://img/ana.png',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(users.create).not.toHaveBeenCalled();
      expect(securityLog.log).toHaveBeenCalledWith('google_link', ctx, {
        userId: 'user-1',
        reason: 'verified_account',
      });
    });

    it('conta com email não verificado: descarta senha e sessões na mesma transação (A-01)', async () => {
      users.findByGoogleId.mockResolvedValue(null);
      users.findByEmail.mockResolvedValue(
        makeUser({ name: 'Ana', avatarUrl: null, emailVerified: false }),
      );
      const linked = makeUser({
        googleId: 'g-123',
        emailVerified: true,
        passwordHash: null,
      });
      users.linkGoogleAccount.mockResolvedValue(linked);

      await expect(service.loginWithGoogle(profile, ctx)).resolves.toBe(linked);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(tx.oAuthExchangeCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(users.linkGoogleAccount).toHaveBeenCalledWith(
        'user-1',
        {
          googleId: 'g-123',
          name: 'Ana',
          avatarUrl: 'https://img/ana.png',
          discardPassword: true,
        },
        tx,
      );
      // Sessões caem antes da vinculação.
      expect(
        tx.refreshToken.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(users.linkGoogleAccount.mock.invocationCallOrder[0]);
      expect(
        tx.oAuthExchangeCode.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(users.linkGoogleAccount.mock.invocationCallOrder[0]);
      expect(securityLog.warn).toHaveBeenCalledWith('google_link', ctx, {
        userId: 'user-1',
        reason: 'unverified_takeover',
      });
    });

    it('NÃO vincula se o Google não verificou o email (evita sequestro de conta)', async () => {
      users.findByGoogleId.mockResolvedValue(null);

      await expect(
        service.loginWithGoogle({ ...profile, emailVerified: false }, ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.findByEmail).not.toHaveBeenCalled();
      expect(users.linkGoogleAccount).not.toHaveBeenCalled();
      expect(users.create).not.toHaveBeenCalled();
    });

    it('cria um usuário sem senha no primeiro login', async () => {
      users.findByGoogleId.mockResolvedValue(null);
      users.findByEmail.mockResolvedValue(null);
      const created = makeUser({
        passwordHash: null,
        googleId: 'g-123',
        emailVerified: true,
      });
      users.create.mockResolvedValue(created);

      await expect(service.loginWithGoogle(profile, ctx)).resolves.toBe(
        created,
      );
      expect(users.create).toHaveBeenCalledWith({
        email: 'ana@example.com',
        googleId: 'g-123',
        name: 'Ana Google',
        avatarUrl: 'https://img/ana.png',
        emailVerified: true,
      });
    });
  });

  describe('createExchangeCode / exchangeCode', () => {
    it('persiste só o hash do código, com expiração curta', async () => {
      prisma.oAuthExchangeCode.create.mockResolvedValue({});
      const before = Date.now();

      const code = await service.createExchangeCode('user-1');

      const expectedHash = createHash('sha256').update(code).digest('hex');
      const { data } = prisma.oAuthExchangeCode.create.mock.calls[0][0];
      expect(data.codeHash).toBe(expectedHash);
      expect(data.userId).toBe('user-1');
      expect(data.expiresAt.getTime()).toBeGreaterThan(before);
      expect(data.expiresAt.getTime()).toBeLessThanOrEqual(before + 61_000);
      expect(JSON.stringify(data)).not.toContain(code);
    });

    it('troca um código válido por tokens e o marca como usado', async () => {
      const user = makeUser();
      prisma.oAuthExchangeCode.findUnique.mockResolvedValue({
        id: 'code-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 30_000),
        user,
      });
      prisma.oAuthExchangeCode.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.exchangeCode('a'.repeat(43), ctx);

      expect(prisma.oAuthExchangeCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'code-1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
      expect(result).toEqual({ ...tokens, user });
      expect(securityLog.log).toHaveBeenCalledWith(
        'google_exchange_success',
        ctx,
        { userId: 'user-1' },
      );
    });

    it.each([
      ['desconhecido', 'not_found', null],
      [
        'já usado',
        'used',
        {
          id: 'c',
          usedAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
          user: makeUser(),
        },
      ],
      [
        'expirado',
        'expired',
        {
          id: 'c',
          usedAt: null,
          expiresAt: new Date(Date.now() - 1),
          user: makeUser(),
        },
      ],
    ])('rejeita código %s com 401', async (_label, reason, stored) => {
      prisma.oAuthExchangeCode.findUnique.mockResolvedValue(stored);

      await expect(
        service.exchangeCode('a'.repeat(43), ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith(
        'google_exchange_failed',
        ctx,
        expect.objectContaining({ reason }),
      );
    });

    it('rejeita quando outro request usou o código primeiro (compare-and-set)', async () => {
      prisma.oAuthExchangeCode.findUnique.mockResolvedValue({
        id: 'code-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 30_000),
        user: makeUser(),
      });
      prisma.oAuthExchangeCode.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.exchangeCode('a'.repeat(43), ctx),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });
  });

  describe('logoutAll', () => {
    it('apaga todas as sessões e os códigos de troca do usuário numa transação, e registra quantas', async () => {
      tx.refreshToken.findMany.mockResolvedValue([
        { familyId: 'f-web' },
        { familyId: 'f-mobile' },
      ]);

      await service.logoutAll('user-1', ctx);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.refreshToken.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        distinct: ['familyId'],
        select: { familyId: true },
      });
      // DELETE, nunca UPDATE de revokedAt: só o usuário, todas as famílias.
      expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(tx.oAuthExchangeCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(securityLog.log).toHaveBeenCalledWith('logout_all', ctx, {
        userId: 'user-1',
        sessionsRemoved: 2,
      });
    });

    it('sem sessões: ainda conclui e registra zero', async () => {
      tx.refreshToken.findMany.mockResolvedValue([]);

      await service.logoutAll('user-1', ctx);

      expect(securityLog.log).toHaveBeenCalledWith('logout_all', ctx, {
        userId: 'user-1',
        sessionsRemoved: 0,
      });
    });
  });

  it('refresh e logout delegam ao TokenService', async () => {
    tokenService.rotateRefreshToken.mockResolvedValue(tokens);
    await expect(service.refresh('rt', ctx)).resolves.toEqual(tokens);
    expect(tokenService.rotateRefreshToken).toHaveBeenCalledWith('rt', ctx);

    await service.logout('rt', ctx);
    expect(tokenService.revokeRefreshToken).toHaveBeenCalledWith('rt', ctx);
  });
});
