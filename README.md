# Dutrail API

Backend do Dutrail (app de atividades ao ar livre, estilo Strava). API REST em
[NestJS](https://nestjs.com) + [Prisma](https://www.prisma.io) + PostgreSQL
([Neon](https://neon.tech)), consumida pelo frontend Angular e, futuramente,
por um app React Native — por isso a API é agnóstica de cliente (tokens no
body, sem cookies de sessão).

Esta etapa cobre **autenticação**: cadastro/login com senha, refresh token com
rotação, logout, login com Google e uma rota protegida de exemplo.

## Stack

| Peça             | Escolha                                                  |
| ---------------- | -------------------------------------------------------- |
| Runtime          | Node 24, ESM (`"type": "module"`), TypeScript 6          |
| Framework        | NestJS 12 (Express)                                      |
| ORM              | Prisma 7 (gerador `prisma-client`, driver adapter `pg`)  |
| Auth             | Passport (`passport-jwt`, `passport-google-oauth20`)     |
| Hash de senha    | Argon2id                                                 |
| Validação        | class-validator / class-transformer                      |
| Rate limiting    | @nestjs/throttler                                        |
| Docs             | @nestjs/swagger em `/docs`                               |
| Testes           | Vitest + Supertest                                       |

## Estrutura

```
src/
├── main.ts                 # bootstrap
├── app.setup.ts            # pipes globais, CORS, Swagger (reusado nos e2e)
├── app.module.ts           # ConfigModule, Throttler, filtro global de erros
├── config/env.validation.ts    # contrato + validação das variáveis de ambiente
├── prisma/                 # PrismaService (global)
├── common/
│   ├── decorators/         # @Public(), @CurrentUser()
│   ├── filters/            # AllExceptionsFilter (formato único de erro)
│   └── dto/                # ErrorResponseDto (Swagger)
├── users/                  # UsersService (dados), GET /me, UserResponseDto
├── auth/
│   ├── auth.controller.ts  # rotas /auth/*
│   ├── auth.service.ts     # casos de uso (signup, login, google, exchange)
│   ├── token.service.ts    # emissão, rotação e revogação de JWT/refresh
│   ├── password.service.ts # argon2
│   ├── strategies/         # JwtStrategy, GoogleStrategy
│   ├── guards/             # JwtAuthGuard (global), GoogleAuthGuard
│   └── dto/                # DTOs de entrada/saída com @ApiProperty
└── generated/prisma/       # client gerado (gitignored; `npm run prisma:generate`)
prisma/schema.prisma        # User, RefreshToken, OAuthExchangeCode
test/                       # e2e (banco real + Google mockado)
```

## Rodando localmente

### 1. Pré-requisitos

- Node 24+ e npm
- Um PostgreSQL. Duas opções:
  - **Neon** (produção/dev remoto): crie um projeto e copie a connection
    string (`postgresql://...?sslmode=require`).
  - **Local via container** (recomendado para dev e obrigatório para os e2e):
    ```bash
    docker compose up -d      # ou: podman compose up -d
    ```
    Sobe um Postgres 17 em `localhost:5433` com os bancos `dutrail` (dev) e
    `dutrail_test` (e2e), usuário/senha `dutrail`/`dutrail`.

### 2. Instalar e configurar

```bash
npm install                 # também roda `prisma generate` (postinstall)
cp .env.example .env        # edite os valores
```

Variáveis principais (todas validadas no boot — ver `src/config/env.validation.ts`):

| Variável                                 | Descrição                                                         |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`                           | Connection string do Postgres (Neon ou local)                     |
| `JWT_SECRET` / `JWT_REFRESH_SECRET`      | Segredos **diferentes**, ≥ 32 chars. Gere com o comando abaixo    |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL`     | Expirações (`15m`, `7d`)                                          |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Credenciais OAuth (seção abaixo)                               |
| `GOOGLE_CALLBACK_URL`                    | `http://localhost:3000/auth/google/callback` em dev               |
| `FRONTEND_URL`                           | Origem do Angular (CORS + redirect pós-Google), ex. `http://localhost:4200` |
| `THROTTLE_TTL_MS` / `THROTTLE_LIMIT`     | Rate limit global (por IP)                                        |

```bash
# gerar segredos
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 3. Credenciais do Google OAuth

1. Acesse <https://console.cloud.google.com/apis/credentials> e crie (ou
   selecione) um projeto.
2. Configure a **OAuth consent screen** (tipo *External*, adicione seu email
   como test user enquanto o app não for publicado).
3. **Create credentials → OAuth client ID → Web application**.
   - *Authorized JavaScript origins*: `http://localhost:4200` (frontend).
   - *Authorized redirect URIs*: `http://localhost:3000/auth/google/callback`
     — precisa ser **idêntica** a `GOOGLE_CALLBACK_URL`.
4. Copie *Client ID* e *Client secret* para o `.env`.

### 4. Migrations e execução

```bash
npm run prisma:migrate      # `prisma migrate dev`: aplica migrations (cria se o schema mudou)
npm run start:dev           # http://localhost:3000, docs em http://localhost:3000/docs
```

Outros scripts: `prisma:deploy` (aplica migrations sem criar novas — use em
produção/CI), `prisma:studio` (UI para inspecionar o banco), `build`,
`start:prod`, `lint`, `format`.

## Endpoints

Documentação interativa (Swagger UI) em **`/docs`**; JSON OpenAPI em `/docs-json`.
Nas rotas protegidas, clique em **Authorize** e cole o `accessToken`.

| Método | Rota                    | Auth          | Descrição                                            |
| ------ | ----------------------- | ------------- | ---------------------------------------------------- |
| POST   | `/auth/signup`          | —             | Cadastro (email + senha). 201 → tokens + user        |
| POST   | `/auth/login`           | —             | Login. 200 → tokens + user; 401 genérico             |
| POST   | `/auth/refresh`         | refresh token | Novo par de tokens; o antigo é invalidado (rotação)  |
| POST   | `/auth/logout`          | refresh token | Revoga o refresh token. 204                          |
| GET    | `/auth/google`          | —             | Redireciona para o consentimento do Google           |
| GET    | `/auth/google/callback` | —             | Retorno do Google → redirect para o frontend com `?code=` |
| POST   | `/auth/google/exchange` | código        | Troca o código de uso único por tokens               |
| GET    | `/me`                   | Bearer        | Usuário autenticado (rota protegida de exemplo)      |

Formato de erro (todas as rotas, via `AllExceptionsFilter`):

```json
{ "statusCode": 401, "error": "Unauthorized", "message": "Invalid credentials", "path": "/auth/login", "timestamp": "..." }
```

`message` é um array em erros de validação (400).

### Fluxo do cliente

1. `signup`/`login` → guarda `accessToken` (memória) e `refreshToken`.
2. Chama a API com `Authorization: Bearer <accessToken>`.
3. Ao receber 401, chama `POST /auth/refresh` com o `refreshToken`, **substitui
   os dois tokens** pelos novos e repete a request.
4. `POST /auth/logout` com o `refreshToken` ao sair.

Google: abra `GET /auth/google` numa janela do browser. Após o consentimento a
API redireciona para `FRONTEND_URL/auth/callback?code=...`; o frontend chama
`POST /auth/google/exchange { code }` (o código vale 60 s, uso único) e recebe
o mesmo payload do login.

## Testes

```bash
npm test                    # unitários (services, filtro, mapeamento Google) — sem banco
npm run test:e2e            # e2e: precisa do Postgres do compose (banco dutrail_test)
npm run test:cov            # cobertura dos unitários
```

Os e2e (`test/auth.e2e-spec.ts`) sobem a aplicação completa contra um banco
real. `test/global-setup.ts` carrega `.env.test` e roda `prisma migrate
deploy`; cada teste **trunca as tabelas** (por isso há uma trava exigindo que
`DATABASE_URL` contenha `test`). A `GoogleStrategy` é substituída por
`test/fakes/fake-google.strategy.ts`, que devolve um perfil configurável sem
falar com o Google, mas exercita a lógica real de criação/vinculação de conta.

Para usar outro banco nos e2e (ex.: um branch do Neon no CI), exporte
`DATABASE_URL` antes de rodar — variáveis do ambiente vencem o `.env.test`.

## Decisões de segurança

**Access token (15 min) + refresh token (7 dias).** O access token é um JWT
stateless (`JWT_SECRET`); o guard só verifica assinatura/expiração, sem ir ao
banco. O refresh token é outro JWT (`JWT_REFRESH_SECRET`, com `jti`) cujo
**SHA-256** fica na tabela `RefreshToken`. Guardar só o hash significa que um
vazamento do banco não entrega sessões válidas.

**Rotação + detecção de reuso.** Cada `/auth/refresh` revoga o token recebido
(compare-and-set atômico, então dois requests concorrentes com o mesmo token
não geram dois pares) e emite outro. Se um token **já rotacionado** for
reapresentado, assumimos roubo e revogamos todas as sessões do usuário. O
logout, por outro lado, apaga o token — reenviá-lo dá um 401 simples, sem
derrubar as outras sessões (um retry do cliente não deve deslogar o celular).

**Refresh token no body, não em cookie `httpOnly`.** Trade-off consciente:

- Cookie `httpOnly` protege o refresh token contra XSS no browser, mas exige
  CORS com `credentials`, mitigação de CSRF (SameSite/CSRF token), domínios
  compatíveis entre API e SPA, e não se aplica ao app React Native.
- Body é uniforme para web e mobile e mantém a API sem estado de cookie. O
  custo é que o cliente web precisa guardar o refresh token (memória ou
  storage), o que o expõe a XSS. Rotação + reuso mitigam o dano: um token
  roubado só serve até o próximo refresh legítimo.
- Se o frontend web quiser o cookie, dá para adicionar um modo "web" que envia
  o refresh token em cookie `httpOnly; SameSite=Lax` sem mudar o resto.

**Callback do Google não coloca tokens na URL.** URLs vazam em histórico,
logs de proxy e `Referer`. O callback gera um código de uso único (hash no
banco, 60 s) e o frontend o troca por tokens em `POST /auth/google/exchange`.

**Vinculação de conta Google.** Ordem: `googleId` → email → criar. A
vinculação por email só acontece se o Google afirma `email_verified`; caso
contrário alguém poderia criar uma conta Google com o email de outra pessoa e
sequestrar a conta local. Contas criadas via Google ficam com `passwordHash`
nulo e recebem o mesmo 401 genérico se alguém tentar login por senha.

**Senhas.** Argon2id (parâmetros OWASP: 19 MiB, t=2, p=1). No login, quando o
email não existe, ainda verificamos contra um hash "dummy" para a resposta
demorar o mesmo tempo e não revelar por timing quais emails estão cadastrados.

**Outros.** Guard JWT global com opt-out explícito via `@Public()`; algoritmo
JWT fixado em HS256; `ValidationPipe` com `whitelist` + `forbidNonWhitelisted`;
rate limit global e mais estrito em `/auth/login` e `/auth/signup` (10/min
por IP); erros 500 nunca expõem a mensagem original; `UserResponseDto` é um
mapeamento explícito (whitelist) — campos novos na tabela não vazam por
acidente.

## Próximos passos sugeridos

- Job para apagar `RefreshToken`/`OAuthExchangeCode` expirados (hoje só acumulam).
- Verificação de email e reset de senha (exigem envio de email).
- `POST /auth/google/token` recebendo o `idToken` do Google Sign-In nativo, para
  o app React Native não depender do fluxo de redirect.
- `trust proxy` no Express quando a API for para trás de um load balancer
  (comentado em `src/app.setup.ts`), senão o rate limit vê o IP do proxy.
