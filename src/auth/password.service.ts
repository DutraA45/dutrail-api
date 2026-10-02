import { Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';

/** Teto da senha, o mesmo do DTO de cadastro, também depois do NFKC (A-09). */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Resultado da verificação. `needsRehash`: a senha só bateu com um hash
 * legado, gerado da senha bruta antes da normalização (A-09).
 */
export type PasswordCheck =
  { valid: false } | { valid: true; needsRehash: boolean };

/**
 * Hash de senha com Argon2id (recomendação atual da OWASP; venceu o Password
 * Hashing Competition). Preferido ao bcrypt por ser resistente a GPU/ASIC e
 * não truncar senhas em 72 bytes.
 *
 * Isolado num service para (a) trocar o algoritmo num lugar só e (b) ser
 * trivialmente mockado nos testes unitários do AuthService.
 */
@Injectable()
export class PasswordService {
  // Parâmetros conforme OWASP Password Storage Cheat Sheet (2024):
  // 19 MiB de memória, 2 iterações, paralelismo 1.
  private readonly options = {
    type: argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
  } as const;

  /**
   * NFKC (A-09): "é" pré-composto e "e" + acento combinante, ou "ｐａｓｓ" de
   * largura total e "pass", viram a mesma senha. Sem isso, quem cadastra num
   * teclado e digita em outro (Android × macOS) pode não conseguir entrar.
   */
  static normalize(plain: string): string {
    return plain.normalize('NFKC');
  }

  hash(plain: string): Promise<string> {
    return hash(PasswordService.normalize(plain), this.options);
  }

  /**
   * Verifica a senha normalizada e, se falhar e a bruta for diferente, a
   * bruta: hashes anteriores ao A-09 foram gerados sem normalizar. O segundo
   * argon2 depende só da senha recebida, não do hash, então quem chama com o
   * hash dummy (email inexistente) gasta o mesmo que com a senha errada.
   */
  async verify(hashed: string, plain: string): Promise<PasswordCheck> {
    const normalized = PasswordService.normalize(plain);
    if (await this.matches(hashed, normalized)) {
      return { valid: true, needsRehash: false };
    }
    if (normalized !== plain && (await this.matches(hashed, plain))) {
      return { valid: true, needsRehash: true };
    }
    return { valid: false };
  }

  /** `verify` lê os parâmetros e o salt de dentro do próprio hash. */
  private async matches(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain);
    } catch {
      // Hash malformado/corrompido: trata como senha errada, não como 500.
      return false;
    }
  }
}
