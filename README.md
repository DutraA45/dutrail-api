# Dutrail API

Backend do Dutrail (app de atividades ao ar livre, estilo Strava). API REST em
[NestJS](https://nestjs.com) + [Prisma](https://www.prisma.io) + PostgreSQL
([Neon](https://neon.tech)), consumida pelo frontend Angular e, futuramente,
por um app React Native — por isso a API é agnóstica de cliente: o mesmo
endpoint atende os dois, e o header `X-Client-Type` define apenas **por onde** o
refresh token trafega (cookie httpOnly para web, corpo JSON para mobile).

Contrato completo da API para quem consome o backend:
[docs/API-CONTRACT.md](docs/API-CONTRACT.md) (autenticação) e
[docs/ACTIVITIES-CONTRACT.md](docs/ACTIVITIES-CONTRACT.md) (atividades).

Implementado até aqui: **autenticação** (cadastro/login com senha, refresh
token com rotação, logout, login com Google, `GET /me`) e **atividades**
(`GET /activities` paginado por cursor, `GET /activities/:id` e
`POST /activities/import`, que cria a atividade a partir de um arquivo `.fit` e
guarda o original num object storage S3-compatível).

## Stack

| Peça          | Escolha                                                 |
| ------------- | ------------------------------------------------------- |
| Runtime       | Node 24, ESM (`"type": "module"`), TypeScript 6         |
| Framework     | NestJS 12 (Express)                                     |
| ORM           | Prisma 7 (gerador `prisma-client`, driver adapter `pg`) |
| Auth          | Passport (`passport-jwt`, `passport-google-oauth20`)    |
| Hash de senha | Argon2id                                                |
| Validação     | class-validator / class-transformer                     |
| Rate limiting | @nestjs/throttler                                       |
| Cookies       | cookie-parser (refresh token do fluxo web)              |
| Upload        | multer (via `@nestjs/platform-express`), em memória     |
| Arquivos .fit | `@garmin/fitsdk` (SDK oficial da Garmin)                |
| Storage       | `@aws-sdk/client-s3` → Oracle Cloud Object Storage      |
| Docs          | @nestjs/swagger em `/docs`                              |
| Testes        | Vitest + Supertest                                      |

## Estrutura

```
src/
├── main.ts                 # bootstrap
├── app.setup.ts            # pipes globais, CORS, Swagger (reusado nos e2e)
├── app.module.ts           # ConfigModule, Throttler, filtro global de erros
├── config/env.validation.ts    # contrato + validação das variáveis de ambiente
├── prisma/                 # PrismaService (global)
├── common/
│   ├── decorators/         # @Public(), @CurrentUser(), @ClientType()
│   ├── filters/            # AllExceptionsFilter (formato único de erro)
│   └── dto/                # ErrorResponseDto (Swagger)
├── users/                  # UsersService (dados), GET /me, UserResponseDto
├── activities/             # GET /activities (cursor), GET /activities/:id, POST /activities/import
│   ├── fit/                # parser .fit → campos de Activity (@garmin/fitsdk)
│   └── storage/            # ActivityFileStorageService (bucket S3-compatível)
├── auth/
│   ├── auth.controller.ts  # rotas /auth/*
│   ├── auth.service.ts     # casos de uso (signup, login, google, exchange)
│   ├── token.service.ts    # emissão, rotação e revogação de JWT/refresh
│   ├── password.service.ts # argon2
│   ├── refresh-token-transport.service.ts  # cookie (web) vs corpo (mobile)
│   ├── strategies/         # JwtStrategy, GoogleStrategy
│   ├── guards/             # JwtAuthGuard (global), GoogleAuthGuard
│   └── dto/                # DTOs de entrada/saída com @ApiProperty
└── generated/prisma/       # client gerado (gitignored; `npm run prisma:generate`)
prisma/schema.prisma        # User, RefreshToken, OAuthExchangeCode, Activity
test/                       # e2e (banco real + Google e storage mockados)
test/fixtures/              # .fit sintético + gerador (build-fit.ts)
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

| Variável                                    | Descrição                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                              | Connection string do Postgres (Neon ou local)                               |
| `JWT_SECRET` / `JWT_REFRESH_SECRET`         | Segredos **diferentes**, ≥ 32 chars. Gere com o comando abaixo              |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL`        | Expirações (`15m`, `7d`)                                                    |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Credenciais OAuth (seção abaixo)                                            |
| `GOOGLE_CALLBACK_URL`                       | `http://localhost:3000/auth/google/callback` em dev                         |
| `FRONTEND_URL`                              | Origem do Angular (CORS + redirect pós-Google), ex. `http://localhost:4200` |
| `THROTTLE_TTL_MS` / `THROTTLE_LIMIT`        | Rate limit global (por IP)                                                  |
| `OCI_S3_ENDPOINT`                           | Endpoint S3-compatível do Object Storage (seção abaixo)                     |
| `OCI_S3_REGION`                             | Região do bucket, ex. `sa-saopaulo-1`                                       |
| `OCI_S3_BUCKET`                             | Bucket dos `.fit` originais, ex. `dutrail-fit-files`                        |
| `OCI_S3_ACCESS_KEY` / `OCI_S3_SECRET_KEY`   | Customer Secret Key da Oracle (**segredo**: só no `.env`, nunca commitado)  |

```bash
# gerar segredos
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 3. Credenciais do Google OAuth

1. Acesse <https://console.cloud.google.com/apis/credentials> e crie (ou
   selecione) um projeto.
2. Configure a **OAuth consent screen** (tipo _External_, adicione seu email
   como test user enquanto o app não for publicado).
3. **Create credentials → OAuth client ID → Web application**.
   - _Authorized JavaScript origins_: `http://localhost:4200` (frontend).
   - _Authorized redirect URIs_: `http://localhost:3000/auth/google/callback`
     — precisa ser **idêntica** a `GOOGLE_CALLBACK_URL`.
4. Copie _Client ID_ e _Client secret_ para o `.env`.

### 4. Object storage dos arquivos `.fit`

Os `.fit` originais importados ficam num bucket do **Oracle Cloud Object
Storage** (Always Free), acessado pela API **compatível com S3**. O código usa
o `@aws-sdk/client-s3` genérico, não um SDK da Oracle, então trocar por outro
provedor S3-compatível (R2, MinIO, S3...) é só trocar as variáveis `OCI_S3_*`.

1. **Endpoint**:
   `https://<namespace>.compat.objectstorage.<região>.oraclecloud.com`. O
   namespace aparece em _Tenancy details_ ou na página do bucket.
2. **Credenciais**: no console da Oracle, _Perfil → Customer secret keys →
   Generate secret key_. O par (access key + secret key) vai para
   `OCI_S3_ACCESS_KEY`/`OCI_S3_SECRET_KEY`. A secret key só é mostrada uma vez.
3. O usuário dono da chave precisa de permissão de leitura/escrita/remoção de
   objetos no bucket.

Chave de cada objeto: `activities/{userId}/{activityId}.fit`, rastreável até o
usuário e a atividade (`Activity.fitFileKey`). Os e2e **não** acessam o
bucket: usam um fake em memória (`test/fakes/fake-activity-file-storage.ts`),
e os valores de `OCI_S3_*` do `.env.test` são fictícios.

### 5. Migrations e execução

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

| Método | Rota                    | Auth          | `X-Client-Type` | Descrição                                                  |
| ------ | ----------------------- | ------------- | --------------- | ---------------------------------------------------------- |
| POST   | `/auth/signup`          | —             | obrigatório     | Cadastro (email + senha). 201 → tokens + user              |
| POST   | `/auth/login`           | —             | obrigatório     | Login. 200 → tokens + user; 401 genérico                   |
| POST   | `/auth/refresh`         | refresh token | obrigatório     | Novo par de tokens; o antigo é invalidado (rotação)        |
| POST   | `/auth/logout`          | refresh token | obrigatório     | Revoga o refresh token. 204                                |
| GET    | `/auth/google`          | —             | —               | Redireciona para o consentimento do Google                 |
| GET    | `/auth/google/callback` | —             | —               | Retorno do Google → redirect para o frontend com `?code=`  |
| POST   | `/auth/google/exchange` | código        | obrigatório     | Troca o código de uso único por tokens                     |
| GET    | `/me`                   | Bearer        | —               | Usuário autenticado (rota protegida de exemplo)            |
| GET    | `/activities`           | Bearer        | —               | Atividades do usuário, paginadas por cursor                |
| GET    | `/activities/:id`       | Bearer        | —               | Detalhe de uma atividade                                   |
| POST   | `/activities/import`    | Bearer        | —               | Upload `.fit` (multipart `file`, ≤ 10 MiB). 201 → Activity |

### `X-Client-Type`: web ou mobile

As rotas que emitem ou leem o refresh token exigem o header `X-Client-Type`,
com valor `web` ou `mobile`. Ausente ou desconhecido → **400**; não há default
silencioso, porque escolher um entregaria o token pelo canal errado.

|                        | `web`                                                                                                  | `mobile`                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Refresh token sai em   | Cookie `refreshToken` (httpOnly, `SameSite=Lax`, `Path=/auth`, `Secure` em produção, `Max-Age` 7 dias) | Corpo JSON                               |
| Refresh token entra em | Cookie                                                                                                 | Corpo JSON (`{ "refreshToken": "..." }`) |
| Corpo da resposta      | `accessToken` (+ `user`)                                                                               | `accessToken`, `refreshToken` (+ `user`) |
| Token no canal errado  | 400                                                                                                    | 400                                      |
| No logout              | Revoga no banco + `clearCookie`                                                                        | Revoga no banco                          |

Rotação, detecção de reuso e revogação são **idênticas** nos dois: a única
diferença é o transporte (`RefreshTokenTransport`). O cliente web precisa de
`withCredentials: true` (Angular) para o cookie ir e voltar.

Formato de erro (todas as rotas, via `AllExceptionsFilter`):

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "Invalid credentials",
  "path": "/auth/login",
  "timestamp": "..."
}
```

`message` é um array em erros de validação (400).

### Fluxo do cliente

1. `signup`/`login` com `X-Client-Type` → guarda o `accessToken` em memória. O
   refresh token: web não o vê (está no cookie); mobile guarda em storage seguro.
2. Chama a API com `Authorization: Bearer <accessToken>`.
3. Ao receber 401, chama `POST /auth/refresh` (web: só o cookie, corpo vazio;
   mobile: `{ refreshToken }`), **substitui os tokens** e repete a request.
4. `POST /auth/logout` ao sair — web também tem o cookie apagado pela resposta.

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

Os e2e (`test/*.e2e-spec.ts`) sobem a aplicação completa contra um banco
real. `test/global-setup.ts` carrega `.env.test` e roda `prisma migrate
deploy`; cada teste **trunca as tabelas** (por isso há uma trava exigindo que
`DATABASE_URL` contenha `test`). A `GoogleStrategy` é substituída por
`test/fakes/fake-google.strategy.ts`, que devolve um perfil configurável sem
falar com o Google, mas exercita a lógica real de criação/vinculação de conta.
O storage dos `.fit` também é um fake em memória, o que permite simular falha
do provedor. O fixture `test/fixtures/running.fit` é sintético, gerado pelo
Encoder da Garmin, e não contém GPS. Para regenerá-lo, rode
`node test/fixtures/build-fit.ts`.

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

**Dois transportes para o refresh token, um por tipo de cliente.**

- **Web usa cookie `httpOnly`**: JavaScript não consegue ler o token, então um
  XSS na SPA não o rouba. O escopo `Path=/auth` mantém o cookie fora das
  chamadas normais da API, e `Secure` (em produção) o restringe a HTTPS.
- **Mobile usa o corpo JSON**: app nativo não tem cookie jar de browser, e o
  token fica no storage seguro do sistema (Keychain/Keystore).
- Aceitar os dois canais na mesma request anularia o ganho do `httpOnly`
  (um XSS poderia simplesmente mandar o token no corpo), por isso token no
  canal errado é 400 — nunca fallback.

**CSRF: `SameSite=Lax` basta aqui, sem token CSRF.** Avaliação:

- Os únicos endpoints autenticados por cookie são `POST /auth/refresh` e
  `POST /auth/logout`. O resto da API usa `Authorization: Bearer`, que é imune
  a CSRF (o browser não anexa o header sozinho).
- `SameSite=Lax` impede o browser de enviar o cookie em POST cross-site — o
  vetor clássico (form auto-submetido em site do atacante) não sai do chão.
- O header obrigatório `X-Client-Type` é, por si, a defesa "custom request
  header" recomendada pela OWASP: um form HTML não consegue definí-lo, e por
  JS ele força preflight CORS, que só a origem `FRONTEND_URL` passa.
- Mesmo que uma request forjada passasse, o atacante não leria a resposta
  (CORS bloqueia), então não haveria roubo de token — no pior caso uma rotação
  forçada.
- **O que mudaria a conclusão:** deploy em que frontend e API ficam em sites
  registráveis diferentes (`app.vercel.app` chamando `api.onrender.com`). Aí o
  cookie `Lax` nem seria enviado pelo XHR — o fluxo web quebraria — e trocar
  para `SameSite=None` exigiria um token CSRF (double-submit) por cima. Com
  API e SPA no mesmo site (`dutrail.com` e `api.dutrail.com`), `Lax` funciona.
  Em dev, `localhost:4200` → `localhost:3000` é mesmo site (a porta não conta).

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
acidente; CORS com origem explícita e `credentials: true` (exigido pelo cookie,
e incompatível com o wildcard `*`).

**Importação de `.fit`.** O dono vem sempre do token. O arquivo é validado
pelo conteúdo (cabeçalho FIT + CRC), e não pela extensão, com teto de 10 MiB
no multer (413) e rate limit próprio (20/min), porque o parse roda no event
loop. Banco e bucket não compartilham transação. A consistência vem da ordem
das etapas: parse e checagem de duplicidade → upload → INSERT. Se o INSERT
falhar, o objeto enviado é apagado; se até essa remoção falhar, a chave vai
para o log. Falhas do storage viram 500 genérico, e o detalhe fica só no log.

## Próximos passos sugeridos

- Job para apagar `RefreshToken`/`OAuthExchangeCode` expirados (hoje só acumulam).
- Verificação de email e reset de senha (exigem envio de email).
- `POST /auth/google/token` recebendo o `idToken` do Google Sign-In nativo, para
  o app React Native não depender do fluxo de redirect.
- Apagar do bucket os `.fit` de um usuário removido: o `onDelete: Cascade`
  apaga as atividades, mas não os objetos no storage.
- Parse do `.fit` num worker thread, se arquivos grandes virarem rotina (~1 s
  de CPU no event loop perto do limite de 10 MiB).
- `trust proxy` no Express quando a API for para trás de um load balancer
  (comentado em `src/app.setup.ts`), senão o rate limit vê o IP do proxy.
