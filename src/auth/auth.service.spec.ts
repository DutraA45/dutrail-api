import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import type { User } from '../generated/prisma/client.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

const tokens = { accessToken: 'access', refreshToken: 'refresh' };

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
    oAuthExchangeCode: { create: any; findUnique: any; updateMany: any };
  };

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
      oAuthExchangeCode: {
        create: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: PasswordService, useValue: password },
        { provide: TokenService, useValue: tokenService },
        { provide: PrismaService, useValue: prisma },
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
    });

    it('rejeita email já cadastrado com 409', async () => {
      users.findByEmail.mockResolvedValue(makeUser());

      await expect(
        service.signup('ana@example.com', 'S3nh@Forte!'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(users.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('devolve tokens quando a senha confere', async () => {
      const user = makeUser();
      users.findByEmail.mockResolvedValue(user);
      password.verify.mockResolvedValue(true);

      const result = await service.login('ana@example.com', 'S3nh@Forte!');

      expect(password.verify).toHaveBeenCalledWith(
        'hash-da-senha',
        'S3nh@Forte!',
      );
      expect(result).toEqual({ ...tokens, user });
    });

    it('rejeita senha errada com 401 genérico', async () => {
      users.findByEmail.mockResolvedValue(makeUser());
      password.verify.mockResolvedValue(false);

      await expect(service.login('ana@example.com', 'errada')).rejects.toThrow(
        'Invalid credentials',
      );
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejeita email desconhecido com o MESMO 401, ainda gastando tempo de hash', async () => {
      users.findByEmail.mockResolvedValue(null);
      password.verify.mockResolvedValue(false);

      await expect(service.login('ninguem@example.com', 'x')).rejects.toThrow(
        'Invalid credentials',
      );
      // Verificação contra um hash "dummy": evita revelar por timing que o
      // email não existe.
      expect(password.hash).toHaveBeenCalledTimes(1);
      expect(password.verify).toHaveBeenCalledTimes(1);
    });

    it('rejeita login por senha em conta só-Google (sem passwordHash)', async () => {
      users.findByEmail.mockResolvedValue(
        makeUser({ passwordHash: null, googleId: 'g-1' }),
      );
      // Mesmo que o verify "passasse" (não passa: é o hash dummy), a ausência
      // de senha tem que bloquear.
      password.verify.mockResolvedValue(true);

      await expect(
        service.login('ana@example.com', 'qualquer'),
      ).rejects.toThrow('Invalid credentials');
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

      await expect(service.loginWithGoogle(profile)).resolves.toBe(user);
      expect(users.findByEmail).not.toHaveBeenCalled();
      expect(users.create).not.toHaveBeenCalled();
    });

    it('vincula a conta Google a um usuário existente com o mesmo email', async () => {
      users.findByGoogleId.mockResolvedValue(null);
      const existing = makeUser({ name: 'Ana', avatarUrl: null });
      users.findByEmail.mockResolvedValue(existing);
      const linked = makeUser({ googleId: 'g-123', emailVerified: true });
      users.linkGoogleAccount.mockResolvedValue(linked);

      await expect(service.loginWithGoogle(profile)).resolves.toBe(linked);
      // Mantém o nome que o usuário já tinha; preenche só o que faltava.
      expect(users.linkGoogleAccount).toHaveBeenCalledWith('user-1', {
        googleId: 'g-123',
        name: 'Ana',
        avatarUrl: 'https://img/ana.png',
      });
      expect(users.create).not.toHaveBeenCalled();
    });

    it('NÃO vincula se o Google não verificou o email (evita sequestro de conta)', async () => {
      users.findByGoogleId.mockResolvedValue(null);

      await expect(
        service.loginWithGoogle({ ...profile, emailVerified: false }),
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

      await expect(service.loginWithGoogle(profile)).resolves.toBe(created);
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

      const result = await service.exchangeCode('a'.repeat(43));

      expect(prisma.oAuthExchangeCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'code-1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
      expect(result).toEqual({ ...tokens, user });
    });

    it.each([
      ['desconhecido', null],
      [
        'já usado',
        {
          id: 'c',
          usedAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
          user: makeUser(),
        },
      ],
      [
        'expirado',
        {
          id: 'c',
          usedAt: null,
          expiresAt: new Date(Date.now() - 1),
          user: makeUser(),
        },
      ],
    ])('rejeita código %s com 401', async (_label, stored) => {
      prisma.oAuthExchangeCode.findUnique.mockResolvedValue(stored);

      await expect(service.exchangeCode('a'.repeat(43))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejeita quando outro request usou o código primeiro (compare-and-set)', async () => {
      prisma.oAuthExchangeCode.findUnique.mockResolvedValue({
        id: 'code-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 30_000),
        user: makeUser(),
      });
      prisma.oAuthExchangeCode.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.exchangeCode('a'.repeat(43))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });
  });

  it('refresh e logout delegam ao TokenService', async () => {
    tokenService.rotateRefreshToken.mockResolvedValue(tokens);
    await expect(service.refresh('rt')).resolves.toEqual(tokens);
    expect(tokenService.rotateRefreshToken).toHaveBeenCalledWith('rt');

    await service.logout('rt');
    expect(tokenService.revokeRefreshToken).toHaveBeenCalledWith('rt');
  });
});
