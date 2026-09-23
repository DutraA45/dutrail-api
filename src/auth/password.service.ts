import { Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';

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

  hash(plain: string): Promise<string> {
    return hash(plain, this.options);
  }

  /** `verify` lê os parâmetros e o salt de dentro do próprio hash. */
  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain);
    } catch {
      // Hash malformado/corrompido: trata como senha errada, não como 500.
      return false;
    }
  }
}
