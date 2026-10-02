import { argon2id, hash as argon2Hash } from 'argon2';
import { PasswordService } from './password.service.js';

// "é" pré-composto (U+00E9) e "e" + acento agudo combinante (U+0301).
const COMPOSED = 'caf\u00e9-S3nh@';
const DECOMPOSED = 'cafe\u0301-S3nh@';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produz um hash argon2id que não contém a senha', async () => {
    const hash = await service.hash('S3nh@Forte!');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('S3nh@Forte!');
  });

  it('gera hashes diferentes para a mesma senha (salt aleatório)', async () => {
    const [a, b] = await Promise.all([
      service.hash('abc12345'),
      service.hash('abc12345'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifica a senha correta e rejeita a errada', async () => {
    const hash = await service.hash('S3nh@Forte!');
    await expect(service.verify(hash, 'S3nh@Forte!')).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
    await expect(service.verify(hash, 's3nh@forte!')).resolves.toEqual({
      valid: false,
    });
  });

  it('trata hash malformado como senha inválida em vez de lançar', async () => {
    await expect(service.verify('nao-e-um-hash', 'qualquer')).resolves.toEqual({
      valid: false,
    });
  });

  describe('normalização NFKC (A-09)', () => {
    it('as duas formas de teste são de fato bytes diferentes', () => {
      expect(COMPOSED).not.toBe(DECOMPOSED);
      expect(COMPOSED.normalize('NFKC')).toBe(DECOMPOSED.normalize('NFKC'));
    });

    it.each([
      ['pré-composto', COMPOSED, DECOMPOSED],
      ['decomposto', DECOMPOSED, COMPOSED],
    ])(
      'cadastrada na forma %s, entra com qualquer das duas',
      async (_label, signupForm, otherForm) => {
        const hash = await service.hash(signupForm);
        for (const attempt of [signupForm, otherForm]) {
          await expect(service.verify(hash, attempt)).resolves.toEqual({
            valid: true,
            needsRehash: false,
          });
        }
      },
    );

    it('largura total ("ｐａｓｓ") equivale à forma normal ("pass")', async () => {
      const fullWidth = '\uff50\uff41\uff53\uff53-1234';
      expect(fullWidth.normalize('NFKC')).toBe('pass-1234');

      await expect(
        service.verify(await service.hash(fullWidth), 'pass-1234'),
      ).resolves.toEqual({ valid: true, needsRehash: false });
      await expect(
        service.verify(await service.hash('pass-1234'), fullWidth),
      ).resolves.toEqual({ valid: true, needsRehash: false });
    });

    it('hash legado (senha bruta decomposta, sem NFKC) ainda confere e pede rehash', async () => {
      const legacy = await argon2Hash(DECOMPOSED, { type: argon2id });

      await expect(service.verify(legacy, DECOMPOSED)).resolves.toEqual({
        valid: true,
        needsRehash: true,
      });
      // A forma pré-composta não é a bruta do cadastro: até o rehash, não entra.
      await expect(service.verify(legacy, COMPOSED)).resolves.toEqual({
        valid: false,
      });
    });

    it('senha errada: tenta a bruta só quando ela difere da normalizada', async () => {
      const hash = await service.hash('S3nh@Forte!');
      const spy = vi.spyOn(
        service as unknown as { matches: () => Promise<boolean> },
        'matches',
      );

      await service.verify(hash, 'ascii-errada');
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockClear();
      await service.verify(hash, DECOMPOSED);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
