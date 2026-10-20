/**
 * Subconjunto do perfil do Google que a aplicação realmente usa.
 * A GoogleStrategy converte o `Profile` do passport para este formato, então
 * o AuthService não depende dos tipos do passport (e fica fácil de testar).
 */
export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
}
