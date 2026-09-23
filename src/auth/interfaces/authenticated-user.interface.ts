/**
 * O que a JwtStrategy coloca em `req.user` após validar o access token.
 * Propositalmente mínimo: quem precisar do usuário completo busca no banco
 * (ver UsersController.me), assim o guard continua stateless e barato.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
}
