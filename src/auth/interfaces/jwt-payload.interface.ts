/** Claims que NÓS colocamos no access token (além de iat/exp do jsonwebtoken). */
export interface AccessTokenPayload {
  /** "subject": id do usuário (claim padrão do JWT). */
  sub: string;
  email: string;
}

/**
 * Claims do refresh token. O `jti` (JWT ID) é um UUID aleatório: sem ele,
 * dois refresh tokens emitidos no mesmo segundo para o mesmo usuário seriam
 * byte a byte idênticos (mesmo payload + mesmo iat) e colidiriam no banco.
 */
export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}
