# Dutrail API

Backend do Dutrail (app de atividades ao ar livre, estilo Strava). API REST em
[NestJS](https://nestjs.com) + [Prisma](https://www.prisma.io) + PostgreSQL
([Neon](https://neon.tech)), consumida pelo frontend Angular e, futuramente,
por um app Android nativo em Kotlin — por isso a API é agnóstica de cliente: o
mesmo endpoint atende os dois, e o header `X-Client-Type` define apenas **por
onde** o refresh token trafega (cookie httpOnly para web, corpo JSON para
mobile).

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
| Docs          | @nestjs/swagger em `/docs` (fora de produção)           |
| Cabeçalhos    | helmet (HSTS, CSP, nosniff, Referrer-Policy)            |
| Testes        | Vitest + Supertest                                      |

## Estrutura

```
src/
├── main.ts                 # bootstrap
├── app.setup.ts            # helmet, pipes globais, CORS, Swagger (reusado nos e2e)
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
│   ├── oauth-state.store.ts    # state + PKCE do Google em cookie assinado
│   ├── google-callback.ts      # códigos de ?error= do callback do Google
│   ├── strategies/         # JwtStrategy, GoogleStrategy
│   ├── guards/             # JwtAuthGuard (global), GoogleAuthGuard, GoogleCallbackGuard
│   ├── filters/            # GoogleCallbackFilter (falha do callback → redirect)
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
    `dutrail_test` (e2e), usuário/senha `dutrail`/`dutrail`. É **só para
    desenvolvimento**: a porta é publicada apenas em loopback (`127.0.0.1`),
    não na rede local. A senha pode ser trocada com `POSTGRES_PASSWORD` no
    ambiente (vale na criação do volume; o `.env.test` assume `dutrail`).

### 2. Instalar e configurar

```bash
npm install                 # também roda `prisma generate` (postinstall)
cp .env.example .env        # edite os valores
```

Variáveis principais (todas validadas no boot — ver `src/config/env.validation.ts`):

| Variável                                    | Descrição                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `NODE_ENV`                                  | **Obrigatório**, sem default: `development`, `test` ou `production`               |
| `DATABASE_URL`                              | Connection string do Postgres (Neon ou local)                                     |
| `JWT_SECRET` / `JWT_REFRESH_SECRET`         | Segredos **diferentes**, ≥ 32 chars (≥ 43 em produção). Gere com o comando abaixo |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL`        | Expirações (`15m`, `7d`): inteiro + `s`/`m`/`h`/`d`, teto de `1h` e `30d`         |
| `JWT_ISSUER`                                | Opcional, padrão `dutrail-api`: claim `iss` dos tokens                            |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Credenciais OAuth (seção abaixo)                                                  |
| `GOOGLE_CALLBACK_URL`                       | `http://localhost:3000/auth/google/callback` em dev                               |
| `FRONTEND_URL`                              | Origem do Angular (CORS + redirect pós-Google), ex. `http://localhost:4200`       |
| `COOKIE_SECURE`                             | Flag `Secure` do cookie do refresh (padrão `true`); `false` recusado em produção  |
| `SECURITY_LOG_ENABLED`                      | Log de eventos de segurança (padrão `true`; `false` no `.env.test`)               |
| `THROTTLE_TTL_MS` / `THROTTLE_LIMIT`        | Rate limit global (por IP)                                                        |
| `OCI_S3_ENDPOINT`                           | Endpoint S3-compatível do Object Storage (seção abaixo)                           |
| `OCI_S3_REGION`                             | Região do bucket, ex. `sa-saopaulo-1`                                             |
| `OCI_S3_BUCKET`                             | Bucket dos `.fit` originais, ex. `dutrail-fit-files`                              |
| `OCI_S3_ACCESS_KEY` / `OCI_S3_SECRET_KEY`   | Customer Secret Key da Oracle (**segredo**: só no `.env`, nunca commitado)        |

```bash
# gerar segredos
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Com `NODE_ENV=production` o boot é mais rígido: `JWT_SECRET` e
`JWT_REFRESH_SECRET` precisam de ≥ 43 caracteres (256 bits em base64url), e
nenhuma credencial (`JWT_*`, `DATABASE_URL`, `GOOGLE_CLIENT_*`,
`OCI_S3_ACCESS_KEY`/`OCI_S3_SECRET_KEY`) pode conter trechos dos placeholders do
`.env.example` (`troque`, `change`, `example`, `xxx`, `secret`, `senha`, sem
diferenciar maiúsculas). Em `development`/`test` valem só as regras de
tamanho mínimo 32 e segredos diferentes. O erro diz qual variável falhou e por
quê, sem mostrar o valor.

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

Em `development` e `test`, o boot emite um **warn** (sem falhar e sem mostrar
valores) quando `GOOGLE_CLIENT_ID` ou `GOOGLE_CLIENT_SECRET` contêm um trecho
de placeholder do `.env.example` (`xxx`, `troque`, `change`, `example`,
`secret`, `senha`), ou quando o caminho de `GOOGLE_CALLBACK_URL` não é
exatamente `/auth/google/callback`. Os dois casos só falhariam lá no Google,
longe da causa. Em `production` os placeholders continuam recusados no boot
(A-05).

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

Os scripts definem o `NODE_ENV` (que vence o do `.env`): `start`, `start:dev`
e `start:debug` usam `development`; `test*` usam `test`; `start:prod` usa
`production` — ou seja, aplica as regras de produção acima e não sobe com os
segredos de dev. Rodando `node dist/main` direto, defina `NODE_ENV` no
ambiente ou no `.env`.

## Endpoints

Documentação interativa (Swagger UI) em **`/docs`**; JSON OpenAPI em `/docs-json`.
Nas rotas protegidas, clique em **Authorize** e cole o `accessToken`. O Swagger
só é registrado fora de produção: com `NODE_ENV=production`, `/docs`,
`/docs-json` e `/docs-yaml` respondem 404.

| Método | Rota                    | Auth          | `X-Client-Type` | Descrição                                                  |
| ------ | ----------------------- | ------------- | --------------- | ---------------------------------------------------------- |
| POST   | `/auth/signup`          | —             | obrigatório     | Cadastro (email + senha). 201 → tokens + user              |
| POST   | `/auth/login`           | —             | obrigatório     | Login. 200 → tokens + user; 401 genérico                   |
| POST   | `/auth/refresh`         | refresh token | obrigatório     | Novo par de tokens; o antigo é invalidado (rotação)        |
| POST   | `/auth/logout`          | refresh token | obrigatório     | Revoga o refresh token. 204                                |
| GET    | `/auth/google`          | —             | —               | Redireciona para o consentimento do Google                 |
| GET    | `/auth/google/callback` | —             | —               | Retorno do Google → redirect para o frontend com `?code=` ou `?error=` |
| POST   | `/auth/google/exchange` | código        | obrigatório     | Troca o código de uso único por tokens                     |
| GET    | `/me`                   | Bearer        | —               | Usuário autenticado (rota protegida de exemplo)            |
| GET    | `/activities`           | Bearer        | —               | Atividades do usuário, paginadas por cursor                |
| GET    | `/activities/:id`       | Bearer        | —               | Detalhe de uma atividade                                   |
| POST   | `/activities/import`    | Bearer        | —               | Upload `.fit` (multipart `file`, ≤ 10 MiB). 201 → Activity |

### `X-Client-Type`: web ou mobile

As rotas que emitem ou leem o refresh token exigem o header `X-Client-Type`,
com valor `web` ou `mobile`. Ausente ou desconhecido → **400**; não há default
silencioso, porque escolher um entregaria o token pelo canal errado.

|                        | `web`                                                                                                | `mobile`                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Refresh token sai em   | Cookie `refreshToken` (httpOnly, `SameSite=Lax`, `Path=/auth`, `Secure`, `Max-Age` = `exp` do token) | Corpo JSON                               |
| Refresh token entra em | Cookie                                                                                               | Corpo JSON (`{ "refreshToken": "..." }`) |
| Corpo da resposta      | `accessToken` (+ `user`)                                                                             | `accessToken`, `refreshToken` (+ `user`) |
| Token no canal errado  | 400                                                                                                  | 400                                      |
| No logout              | Revoga no banco + `clearCookie`                                                                      | Revoga no banco                          |

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
o mesmo payload do login. Se algo falhar, o redirect vem com
`?error=access_denied | email_not_verified | state_mismatch | oauth_failed`
(ver [Login com Google](#login-com-google-state-pkce-e-erros)).

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
`test/fakes/fake-google.strategy.ts`, que é a strategy real (state, PKCE,
cookie, tratamento de erros, criação/vinculação de conta) com só as duas
chamadas de rede ao Google trocadas: o endpoint de token aceita o `code` apenas
com o `code_verifier` certo (S256), como o Google, e o userinfo devolve um
perfil configurável. `test/google-oauth.e2e-spec.ts` cobre o fluxo de ponta a
ponta (login CSRF, injeção de `code`, cookie adulterado/expirado, cancelamento,
erros do Google e varredura dos logs).
O storage dos `.fit` também é um fake em memória, o que permite simular falha
do provedor. O fixture `test/fixtures/running.fit` é sintético, gerado pelo
Encoder da Garmin, e não contém GPS. Para regenerá-lo, rode
`node test/fixtures/build-fit.ts`.

`test/swagger-by-env.e2e-spec.ts` sobe a app também com `NODE_ENV=development`
e `production` (reimportando o `AppModule` com o ambiente trocado). Todas as
variáveis vêm do `.env.test`, e em produção os segredos são gerados na hora,
só para aquele processo.

Para usar outro banco nos e2e (ex.: um branch do Neon no CI), exporte
`DATABASE_URL` antes de rodar — variáveis do ambiente vencem o `.env.test`.

## Decisões de segurança

**Access token (15 min) + refresh token (7 dias).** O access token é um JWT
stateless (`JWT_SECRET`); o guard só verifica assinatura/expiração, sem ir ao
banco. O refresh token é outro JWT (`JWT_REFRESH_SECRET`, com `jti`) cujo
**SHA-256** fica na tabela `RefreshToken`. Guardar só o hash significa que um
vazamento do banco não entrega sessões válidas.

**Claims e algoritmo conferidos nos dois tokens.** Ambos são HS256 e levam
`iss` (`JWT_ISSUER`, padrão `dutrail-api`) e um `aud` próprio do tipo:
`dutrail-access` ou `dutrail-refresh`. O guard do Bearer e o `/auth/refresh`
recusam token com outro algoritmo, outro emissor ou a audiência do outro tipo.
Assim um não passa pelo outro mesmo que algum dia compartilhem segredo. Os
TTLs são validados no boot: só inteiro + unidade (`"15"` sem unidade seria
lido como 15 ms pelo jsonwebtoken), com teto de 1h para o access e 30d para
o refresh.

> **Tokens anteriores a essa mudança (A-14) não valem mais.** Os emitidos
> antes não têm `iss` nem `aud`, então access tokens recebem 401 no Bearer e
> refresh tokens recebem 401 `Invalid refresh token` no `/auth/refresh`: todo
> usuário precisa fazer login de novo uma vez. Aceito por estarmos em
> pré-produção. O mesmo acontece sempre que `JWT_ISSUER` mudar.

**Mesmo 401 para todo refresh token recusado.** JWT inválido ou expirado,
token desconhecido, rotação concorrente e reuso respondem igual,
`Invalid refresh token`, para quem roubou um token não saber, por exemplo, que
o reuso foi detectado. O motivo vai só para o [log de segurança](#logs-de-segurança).
Token ausente continua com `Missing refresh token`, porque não revela nada
sobre um token.

**Rotação + detecção de reuso.** Cada `/auth/refresh` revoga o token recebido
(compare-and-set atômico, então dois requests concorrentes com o mesmo token
não geram dois pares) e emite outro. Se um token **já rotacionado** for
reapresentado, assumimos roubo e revogamos todas as sessões do usuário. O
logout, por outro lado, apaga o token — reenviá-lo dá um 401 simples, sem
derrubar as outras sessões (um retry do cliente não deve deslogar o celular).

**Dois transportes para o refresh token, um por tipo de cliente.**

- **Web usa cookie `httpOnly`**: JavaScript não consegue ler o token, então um
  XSS na SPA não o rouba. O escopo `Path=/auth` mantém o cookie fora das
  chamadas normais da API, e `Secure` (padrão; ver `COOKIE_SECURE`) o
  restringe a HTTPS.
- **Mobile usa o corpo JSON**: app nativo não tem cookie jar de browser, e o
  token fica no armazenamento seguro do Android (Android Keystore protegendo
  os tokens, ex. DataStore criptografado).
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

### Login com Google: state, PKCE e erros

**`state` + PKCE (S256) num cookie assinado (A-02).** Sem eles, o callback
aceitaria qualquer `code`, e um atacante poderia logar a vítima na conta
_dele_ (login CSRF: as atividades que ela importasse iriam para o atacante).
Como a sessão do Express está desligada, o `OAuthStateStore`
(`src/auth/oauth-state.store.ts`) substitui o store de sessão do
passport-oauth2:

- `GET /auth/google` gera um `state` de 256 bits; o `code_verifier` (43
  caracteres, RFC 7636) é gerado pela própria strategy, que deriva o
  `code_challenge` dele. Os dois vão para o cookie `googleOAuthState`:
  HttpOnly, `SameSite=Lax`, `Path=/auth/google`, `Secure` conforme
  `COOKIE_SECURE`, 10 minutos. `Lax` e não `Strict`: o callback chega por
  navegação vinda de `accounts.google.com`, e com `Strict` o browser não
  mandaria o cookie.
- O conteúdo é assinado com HMAC-SHA256 e carrega a própria expiração. A chave
  é derivada do `JWT_SECRET` por HKDF com o rótulo fixo `dutrail-oauth-state`,
  sem variável nova: o rótulo separa os usos, e quem tem o `JWT_SECRET` já
  forjaria qualquer access token. Trocar o `JWT_SECRET` só derruba logins com
  Google em andamento (no máximo 10 minutos).
- No callback, o `state` da URL é comparado com o do cookie em tempo constante,
  e o `code_verifier` do cookie vai na troca do `code`. O cookie é apagado na
  entrada do callback (mesmas opções), então some em qualquer desfecho.
- O `state` vai na URL do Google, como manda o protocolo. O `code_verifier` só
  existe dentro do cookie. Nenhum dos dois, nem o cookie, aparece em log ou
  resposta JSON.
- O store recebe só o `req` do passport-oauth2, mas precisa setar o cookie
  antes de a strategy responder o 302. Por isso usa o `req.res`, que o Express
  liga a toda request.

Consequência para o cliente: o browser precisa aceitar cookies de primeira
parte da API durante o redirect. Dois logins simultâneos no mesmo browser:
vale o último.

**Falhas do callback vão para o frontend (A-13).** O `GoogleCallbackGuard`
classifica cada desfecho e o `GoogleCallbackFilter` responde
`302 {FRONTEND_URL}/auth/callback?error=<código>`, nunca JSON nem 500:
`access_denied` (cancelamento), `email_not_verified`, `state_mismatch` e
`oauth_failed` (`code` inválido, outro `error=` do Google, falha interna). Nada
que o Google manda (`error_description`) é repassado. Erros do OAuth não geram
stack no log. Um erro interno inesperado (banco fora, bug) também vira
`oauth_failed` para o usuário, mas o stack é logado, só com o path.

**Vinculação de conta Google.** Ordem: `googleId` → email → criar. A
vinculação por email só acontece se o Google afirma `email_verified`; caso
contrário alguém poderia criar uma conta Google com o email de outra pessoa e
sequestrar a conta local. Contas criadas via Google ficam com `passwordHash`
nulo e recebem o mesmo 401 genérico se alguém tentar login por senha.

Ao vincular por email, o resultado depende de a conta local já ter o email
verificado:

- **Email não verificado** (caso de todo signup por senha, porque ainda não
  há verificação de email): nada garante que quem fez o cadastro era o dono do
  email. Sem o descarte, quem cadastrou o email de outra pessoa com uma senha
  própria continuaria entrando na conta depois que a dona a vinculasse ao
  Google (_account pre-hijacking_, A-01 em
  [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)). Por isso, numa
  única transação, a conta **perde a senha** (`passwordHash` nulo, e
  `hasPassword: false` na resposta) e **todas as sessões** (refresh tokens e
  códigos de troca pendentes são apagados). A partir daí o login é só com
  Google.
- **Email já verificado**: a conta ganha o `googleId` e **mantém a senha** e
  as sessões.

Ainda não existe fluxo para definir uma senha nova: uma conta que perdeu a
senha na vinculação só volta a ter login por senha quando houver reset de
senha (ver Próximos passos).

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

**Cabeçalhos de segurança (helmet).** Toda resposta, inclusive 401/404,
sai com:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (sem
  `preload`). **A aplicação emite o HSTS.** Se o proxy reverso da VM também
  emitir, tudo bem, desde que com o mesmo valor. Com dois headers HSTS na
  resposta, o browser processa só o primeiro (RFC 6797 §8.1), e a política
  efetiva passaria a depender da ordem em que o proxy insere o dele. O mais
  simples é o proxy não adicionar o seu nem sobrescrever o da app.
- CSP padrão do helmet com `frame-ancestors 'none'`, mais
  `X-Frame-Options: DENY` para browsers antigos.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Sem
  `X-Powered-By`.
- `Cross-Origin-Resource-Policy: same-origin` (padrão do helmet). O frontend
  não é afetado: o browser só aplica o CORP a requests `no-cors` (`<img>`,
  `<script>`), e o Angular chama a API com `fetch`/XHR em modo CORS.

As rotas do Swagger (`/docs`, `/docs/*`, `/docs-json`), que só existem fora
de produção, recebem a mesma CSP sem `upgrade-insecure-requests`. Em
`http://localhost` essa diretiva mandaria os assets e o "Try it out" para
`https://`. O resto da CSP basta para a UI: scripts vêm do próprio `/docs` e
os `<style>` inline já são permitidos pela padrão.

**Importação de `.fit`.** O dono vem sempre do token. O arquivo é validado
pelo conteúdo (cabeçalho FIT + CRC), e não pela extensão, com teto de 10 MiB
no multer (413) e rate limit próprio (20/min), porque o parse roda no event
loop. Banco e bucket não compartilham transação. A consistência vem da ordem
das etapas: parse e checagem de duplicidade → upload → INSERT. Se o INSERT
falhar, o objeto enviado é apagado; se até essa remoção falhar, a chave vai
para o log. Falhas do storage viram 500 genérico, e o detalhe fica só no log.

## Logs de segurança

Eventos de autenticação e abuso saem como **uma linha JSON por evento**, pelo
Logger do Nest com o contexto `SecurityLog` (`src/security/security-log.service.ts`).
Falhas e suspeitas usam o nível `warn`, e sucessos usam `log`.
`SECURITY_LOG_ENABLED=false` silencia esse log, o que só faz sentido nos
testes.

```
[Nest] 1234  - 01/10/2026, 14:00:00   WARN [SecurityLog] {"event":"login_failed","timestamp":"2026-10-01T17:00:00.000Z","userId":"…","ip":"203.0.113.7","userAgent":"Mozilla/5.0 …","clientType":"web","emailMasked":"a***@e***.com","reason":"wrong_password"}
```

| Evento                    | Nível           | Quando                                                                                  | `reason`                                                     |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `signup`                  | log             | Cadastro concluído (com email mascarado)                                                | —                                                            |
| `login_success`           | log             | Login por senha                                                                         | —                                                            |
| `login_failed`            | warn            | Login recusado (com email mascarado). O cliente recebe sempre o mesmo 401               | `unknown_email`, `no_password` (conta só-Google), `wrong_password` |
| `refresh_success`         | log             | Rotação do refresh token                                                                | —                                                            |
| `refresh_invalid`         | warn            | Refresh recusado. O cliente recebe sempre `Invalid refresh token` (ou `Missing refresh token` sem token) | `missing_token`, `invalid_jwt`, `expired`, `not_found`, `concurrent_rotation` |
| `refresh_reuse_detected`  | warn            | Token já rotacionado reapresentado: **todas as sessões do usuário foram revogadas**. O cliente recebe o mesmo `Invalid refresh token` | —                                                            |
| `logout`                  | log / warn      | Logout (warn só quando o token tem assinatura inválida, caso em que a resposta é 401)   | `no_token`, `not_found`, `invalid_jwt`, `expired`            |
| `google_link`             | log / warn      | Conta Google vinculada a uma conta local com o mesmo email                              | `verified_account` (log), `unverified_takeover` (warn: senha e sessões descartadas, A-01) |
| `google_exchange_success` | log             | `POST /auth/google/exchange` entregou tokens                                            | —                                                            |
| `google_exchange_failed`  | warn            | Código de troca recusado, ou falha em `GET /auth/google/callback` (um `reason` por `?error=`) | troca: `not_found`, `used`, `expired`, `concurrent_use`; callback: `state_mismatch`, `access_denied`, `email_not_verified`, `callback_error` (= `oauth_failed`) |
| `rate_limited`            | warn            | 429 do throttler, em qualquer rota                                                      | —                                                            |

**Campos.** `event`, `timestamp` (ISO 8601) e, quando houver, `userId`, `ip`
(`req.ip`), `userAgent` (truncado em 200 caracteres), `clientType`,
`emailMasked` e `reason`. O `reason` é sempre um código fixo, garantido pelo
tipo `SecurityReason`, e nunca texto livre nem mensagem de exceção. Campos
ausentes não aparecem na linha.

> **IP atrás de proxy.** Enquanto o `trust proxy` não for configurado (A-03),
> `ip` é o endereço de quem abriu a conexão TCP. Atrás de um proxy ou load
> balancer, esse é o IP do proxy, e não o do cliente.

**Nunca vão para o log:** senha, tokens (access, refresh, código de troca do
Google, `code`/`state` do callback, `code_verifier` e o cookie de state), hashes (de senha, de token, de email),
query string de URL e email em claro. Quando é preciso identificar o email
(`signup`, `login_failed`), ele sai mascarado (`ana@example.com` →
`a***@e***.com`), e não em hash: o hash de um email é revertido por
dicionário. O serviço recebe o email cru e faz a máscara ele mesmo, para que
nenhum chamador esqueça. Como a linha é JSON, uma quebra de linha no
user-agent não consegue forjar uma linha falsa. O
`test/security-log.e2e-spec.ts` executa um fluxo completo e varre **todas**
as linhas de log em busca desses valores.

**Como os dados chegam ao log.** O controller monta um `SecurityContext`
(`ip`, `userAgent`, `clientType`) a partir do `req` e o passa como parâmetro
ao `AuthService` e ao `TokenService`. Não há provider request-scoped nem
AsyncLocalStorage. O 429 acontece num guard, antes de qualquer service, e por
isso é registrado pelo `AllExceptionsFilter`. As falhas do callback do Google
são registradas pelo `GoogleCallbackFilter`, que também faz o redirect.

**Alertas sugeridos:**

- `refresh_reuse_detected`: **alertar em qualquer ocorrência**. É roubo de
  token ou um bug de cliente, e nos dois casos o usuário foi deslogado de
  todos os dispositivos.
- Picos de `login_failed`, por `ip` (força bruta) ou em muitos
  `emailMasked` distintos a partir de poucos IPs (credential stuffing).
- Picos de `rate_limited` por `ip`.
- `google_link` com `unverified_takeover`: raro e legítimo, mas vale revisar
  (é o desfecho de uma tentativa de pre-hijacking).

## Próximos passos sugeridos

- Job para apagar `RefreshToken`/`OAuthExchangeCode` expirados (hoje só acumulam).
- Verificação de email e reset de senha (exigem envio de email).
- `POST /auth/google/token` recebendo o `idToken` do Google Sign-In nativo, para
  o app Android não depender do fluxo de redirect.
- Apagar do bucket os `.fit` de um usuário removido: o `onDelete: Cascade`
  apaga as atividades, mas não os objetos no storage.
- Parse do `.fit` num worker thread, se arquivos grandes virarem rotina (~1 s
  de CPU no event loop perto do limite de 10 MiB).
- `trust proxy` no Express quando a API for para trás de um load balancer
  (comentado em `src/app.setup.ts`), senão o rate limit vê o IP do proxy.
