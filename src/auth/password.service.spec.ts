import { PasswordService } from './password.service.js';

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
    await expect(service.verify(hash, 'S3nh@Forte!')).resolves.toBe(true);
    await expect(service.verify(hash, 's3nh@forte!')).resolves.toBe(false);
  });

  it('trata hash malformado como senha inválida em vez de lançar', async () => {
    await expect(service.verify('nao-e-um-hash', 'qualquer')).resolves.toBe(
      false,
    );
  });
});
