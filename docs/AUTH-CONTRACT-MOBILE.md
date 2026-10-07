# Contrato da API de Autenticação — Dutrail (app Android)

Contrato de autenticação para o app Android nativo em Kotlin. **Cobre somente
`X-Client-Type: mobile`** e é autossuficiente: o app não precisa de outro
documento para autenticar. Documentos complementares, no mesmo diretório:

- [`ACTIVITIES-CONTRACT.md`](ACTIVITIES-CONTRACT.md): rotas `/activities`,
  que seguem os padrões descritos aqui (Bearer, formato de erro, refresh no
  401, 429).
- [`API-CONTRACT.md`](API-CONTRACT.md): o mesmo contrato do ponto de vista do
  cliente web (refresh token em cookie). Não é necessário para o app.

Conferido contra o código e contra requisições reais (servidor em
`development`, banco descartável) em 2026-10-05. Os exemplos de resposta
saíram dessas requisições, com os tokens truncados em `…`.

> **Resumo para quem implementa o cliente**
>
> 1. Toda request leva `X-Client-Type: mobile`; nas rotas de token, sem ele a resposta é 400.
> 2. Os dois tokens vêm e vão no corpo JSON. O cliente HTTP não usa cookies: um cookie `refreshToken` na request dá 400.
> 3. Guarde os dois tokens em armazenamento seguro (Android Keystore). Não decodifique o JWT.
> 4. Cada `/auth/refresh` devolve um par novo: persista os dois antes de refazer a request. O refresh antigo não serve mais.
> 5. Um único refresh em voo (lock no `Authenticator`); as outras requests esperam e reutilizam o token novo.
> 6. 401 numa rota com Bearer (inclusive `/auth/logout-all`): refresh e repete uma vez. 401 no próprio `/auth/refresh`: sessão encerrada.
> 7. Erro de rede no refresh: mantenha o token enviado e repita uma vez, logo em seguida. 429 e 5xx no refresh não encerram a sessão.
> 8. 429: "muitas tentativas, aguarde"; o header `Retry-After` (segundos) diz quanto.
> 9. Decida pelo `statusCode` e pela rota, nunca pelo texto de `message` (string ou array).
> 10. Não fixe TTLs nem limites no app. Login com Google ainda não funciona no app.

## Visão geral

- **Access token**: JWT curto, no corpo (`accessToken`), enviado em
  `Authorization: Bearer <accessToken>`. Opaco para o app.
- **Refresh token**: JWT longo e de uso único, no corpo (`refreshToken`). O
  app o recebe no corpo e o envia no corpo.
- Os dados do usuário vêm do objeto `user` das respostas ou de `GET /me`.
- O servidor guarda só o SHA-256 dos tokens e faz rotação, detecção de reuso
  e revogação.

Base em desenvolvimento: `http://localhost:3000`. A URL base de produção não
faz parte deste documento (ver [Pendências do contrato](#pendências-do-contrato)).

**Swagger.** `/docs` (UI) e `/docs-json` (OpenAPI) existem só com `NODE_ENV`
diferente de `production`. Em produção respondem 404, e a referência é este
documento. Há um snapshot versionado do OpenAPI em
[`openapi.json`](openapi.json) (data e comando para regenerar na nota do topo
de [`API-CONTRACT.md`](API-CONTRACT.md)). Os tipos dele batem com este
documento: `user.name` e `user.avatarUrl` são `string` anulável e sempre
presentes (`String?` em Kotlin), e os inteiros vêm como `integer`.

## `X-Client-Type`

No app, o valor é sempre `mobile` (o servidor aceita maiúsculas e ignora
espaços nas pontas).

| Rota                                                                                         | `X-Client-Type`            | Sem o header ou com valor desconhecido |
| -------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------- |
| `POST /auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/google/exchange` | obrigatório                | **400**                                |
| `POST /auth/logout-all`                                                                      | obrigatório (além do Bearer) | **400** (com Bearer válido; sem Bearer, 401 antes) |
| `GET /me`, rotas `/activities`, `GET /auth/google`                                           | ignorado                   | segue normalmente                      |

Como o header é ignorado onde não é usado, mande-o em toda request.
Mensagens (string):

- ausente: `x-client-type header is required (expected one of: web, mobile)`;
- valor desconhecido: `x-client-type header must be one of: web, mobile`.

O header é conferido antes do corpo: sem o header e com corpo inválido, a
resposta é o 400 do header.

## Endpoints

| Método | Rota                    | Autenticação | Corpo enviado                | Sucesso | Corpo da resposta                       | Limite por IP |
| ------ | ----------------------- | ------------ | ---------------------------- | ------- | --------------------------------------- | ------------- |
| POST   | `/auth/signup`          | —            | `email`, `password`, `name?` | 201     | `{ accessToken, refreshToken, user }`   | 10/min        |
| POST   | `/auth/login`           | —            | `email`, `password`          | 200     | `{ accessToken, refreshToken, user }`   | 10/min        |
| POST   | `/auth/refresh`         | refresh token no corpo | `refreshToken`     | 200     | `{ accessToken, refreshToken }`         | 30/min        |
| POST   | `/auth/logout`          | refresh token no corpo | `refreshToken`     | 204     | vazio                                   | 30/min        |
| POST   | `/auth/logout-all`      | Bearer       | vazio (ignorado)             | 204     | vazio                                   | 20/min        |
| POST   | `/auth/google/exchange` | —            | `code`                       | 200     | `{ accessToken, refreshToken, user }`   | 20/min        |
| GET    | `/me`                   | Bearer       | —                            | 200     | `user` na raiz                          | 100/min       |

Nenhuma resposta com `X-Client-Type: mobile` traz `Set-Cookie`. Os limites
são por IP e por rota, valores atuais do servidor; ver [Rate limit](#rate-limit).
`GET /auth/google` também existe, mas o app não consegue concluir esse fluxo
(ver [Login com Google](#login-com-google)).

## O objeto `user`

Igual em `signup`, `login`, `google/exchange` e `GET /me` (este na raiz, sem
envelope):

```json
{
  "id": "97a04ba6-f834-4e32-a0f6-d1c28b37fde4",
  "email": "ana@example.com",
  "name": "Ana",
  "avatarUrl": null,
  "emailVerified": false,
  "hasPassword": true,
  "createdAt": "2026-10-05T20:58:54.675Z"
}
```

| Campo           | Tipo JSON         | Kotlin sugerido | Significado                                                    |
| --------------- | ----------------- | --------------- | -------------------------------------------------------------- |
| `id`            | string (UUID)     | `String`        | Identificador do usuário                                       |
| `email`         | string            | `String`        | Email normalizado (sem espaços nas pontas, minúsculo)          |
| `name`          | string ou `null`  | `String?`       | Nome; `null` se não informado                                  |
| `avatarUrl`     | string ou `null`  | `String?`       | Foto (hoje só vem do Google)                                   |
| `emailVerified` | boolean           | `Boolean`       | `true` só para contas criadas ou vinculadas pelo Google        |
| `hasPassword`   | boolean           | `Boolean`       | `false` para conta sem senha (ver [Login com Google](#login-com-google)) |
| `createdAt`     | string (ISO 8601) | `Instant`       | Criação da conta                                               |

Os campos nulos vêm como `null`, nunca omitidos. Nenhuma resposta contém
senha, hash de senha ou `googleId`.

## Cadastro e login

Campos desconhecidos são rejeitados com 400 (não são ignorados).

| Campo      | `POST /auth/signup`                                    | `POST /auth/login`              |
| ---------- | ------------------------------------------------------ | ------------------------------- |
| `email`    | obrigatório, email válido; o servidor tira espaços e põe em minúsculas | idem                |
| `password` | obrigatório, 8 a 128 caracteres                        | obrigatório, 1 a 128 caracteres |
| `name`     | opcional, até 100 caracteres (espaços nas pontas removidos) | não aceito (400)           |

**Normalização NFKC.** O servidor normaliza a senha em NFKC no cadastro e no
login: formas Unicode equivalentes entram igual ("é" pré-composto ou "e" +
acento combinante; "ｐａｓｓ" de largura total ou "pass"), o que evita falha
de login entre teclados diferentes. Envie a senha como digitada, sem
normalizar no app. O limite de 128 vale também depois da normalização, que
pode aumentar o texto (ex.: "㍿" vira 4 caracteres); se passar, 400.

**Senha vazada.** No cadastro, a senha é conferida numa base de senhas
vazadas (Have I Been Pwned). Se constar, 400, e o formulário deve pedir outra
senha. Se a base estiver indisponível, o cadastro segue. O login não faz essa
checagem.

**Ordem das checagens do cadastro:** validação dos campos (400), limite de
128 depois do NFKC (400), email já cadastrado (409), senha vazada (400).

### Exemplos

```http
POST /auth/login
Content-Type: application/json
X-Client-Type: mobile

{ "email": "ana@example.com", "password": "S3nh@Forte!" }
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "user": {
    "id": "97a04ba6-f834-4e32-a0f6-d1c28b37fde4",
    "email": "ana@example.com",
    "name": "Ana",
    "avatarUrl": null,
    "emailVerified": false,
    "hasPassword": true,
    "createdAt": "2026-10-05T20:58:54.675Z"
  }
}
```

`POST /auth/signup` responde no mesmo formato, com status 201.

```http
POST /auth/refresh
Content-Type: application/json
X-Client-Type: mobile

{ "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…" }

HTTP/1.1 200 OK

{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
}
```

```http
POST /auth/logout
Content-Type: application/json
X-Client-Type: mobile

{ "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…" }

HTTP/1.1 204 No Content
```

## Validade dos tokens e sessões

Padrões **configuráveis** no servidor. Não são garantia e podem mudar por
ambiente sem aviso ao app; não os fixe no código.

| Item                                     | Variável                | Padrão                              |
| ---------------------------------------- | ----------------------- | ----------------------------------- |
| Access token                             | `JWT_ACCESS_TTL`        | 15 minutos (máximo 1 hora)          |
| Refresh token                            | `JWT_REFRESH_TTL`       | 7 dias (máximo 30 dias)             |
| Janela de tolerância do refresh já usado | `REFRESH_GRACE_SECONDS` | 30 segundos (máximo 60; 0 desativa) |

**Janela deslizante.** Cada `/auth/refresh` bem-sucedido emite um refresh
token novo com a validade completa, contada a partir dali. Não há duração
máxima de sessão: ela termina se o app passar um `JWT_REFRESH_TTL` inteiro
sem renovar, ou se for encerrada (logout, logout de todos os dispositivos,
reuso detectado nesta sessão, ou vinculação ao Google de conta não
verificada).

Consequência para o app: **renovar ao receber 401 basta.** Não leia o `exp`
dos tokens nem agende renovação. Um 401 por access token expirado é esperado
no uso normal e é tratado pelo `Authenticator` (ver [Interceptor](#interceptor)).
Quem abre o app pelo menos uma vez dentro da validade do refresh token
continua logado; depois disso, o refresh da inicialização recebe 401 e o app
mostra o login.

### Sessão por dispositivo e janela de tolerância

Cada login (senha, cadastro ou Google) abre uma **sessão** própria deste
aparelho; as renovações continuam na mesma sessão.

Um refresh token que acabou de ser trocado ainda pode ser reapresentado **uma
única vez**, por até `REFRESH_GRACE_SECONDS` (30 s no padrão) depois da troca,
desde que o token que o substituiu ainda não tenha sido usado. A repetição
recebe um par novo e válido da mesma sessão. É para quando a resposta do
refresh se perde (timeout, troca de Wi-Fi/4G, app morto em background): o
servidor renovou, mas o app ficou com o token antigo. Ver
[Erro de rede no refresh](#erro-de-rede-no-refresh).

Fora disso, reapresentar um refresh token já usado é **reuso**: o servidor
encerra **a sessão deste aparelho** (todos os tokens dela) e responde 401
`Invalid refresh token`. As sessões do mesmo usuário em outros aparelhos e no
web continuam. Contam como reuso:

- repetir depois da janela;
- repetir pela segunda vez o mesmo token (a tolerância vale uma vez);
- repetir um token cujo substituto já foi usado num refresh;
- três ou mais refreshes simultâneos com o mesmo token (o terceiro esgota a
  tolerância e encerra a sessão).

## Logout e logout de todos os dispositivos

**`POST /auth/logout`** com `{ "refreshToken": "..." }` encerra a sessão
deste aparelho e responde 204. É idempotente: sem `refreshToken` no corpo, ou
com um token que já não existe, também 204. Só um JWT com assinatura
inválida, adulterado ou expirado recebe 401 `Invalid refresh token`. Limpe o
estado local em qualquer caso.

**`POST /auth/logout-all`** encerra **todas** as sessões do usuário: deste
aparelho, de outros celulares e do web. Uso típico: celular perdido.

- Autentica pelo **Bearer**, não pelo refresh token. O corpo é ignorado.
- Exige `X-Client-Type: mobile`.
- Idempotente: sem sessões abertas, 204 do mesmo jeito.

```http
POST /auth/logout-all
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
X-Client-Type: mobile

HTTP/1.1 204 No Content
```

Nos dois casos, **o access token continua válido até expirar** (é stateless,
até `JWT_ACCESS_TTL`): descarte os dois tokens e limpe o estado local logo
depois da resposta. Depois de um logout-all, os outros dispositivos continuam
com o access token que já tinham até ele expirar, e no próximo
`/auth/refresh` recebem 401 `Invalid refresh token`.

## Login com Google

> **O app ainda NÃO consegue concluir este fluxo.** O callback do Google
> sempre termina num redirect para o cliente **web**
> (`{FRONTEND_URL}/auth/callback?code=...` ou `?error=...`); não há destino
> de redirect para o app, então ele nunca recebe o `code` a trocar. O login
> nativo (`POST /auth/google/token` recebendo o `idToken` do Google) ainda não
> existe. Não implemente login com Google no app contra o fluxo atual.

Como o fluxo funciona hoje, para referência:

1. Navegação de browser (não chamada HTTP) para `{API}/auth/google`: 302 para
   o Google e um cookie curto de state (`googleOAuthState`, `HttpOnly`,
   `SameSite=Lax`, `Path=/auth/google`, 10 minutos), que liga o callback ao
   browser que iniciou o login. O cliente não manipula esse cookie.
2. O Google chama de volta a API, que confere o `state`, troca o code com o
   Google (PKCE) e cria ou vincula o usuário. Nenhum token é emitido aqui.
3. A API redireciona para `{FRONTEND_URL}/auth/callback?code=<43 caracteres>`
   ou `?error=<código>` (`access_denied`, `email_not_verified`,
   `state_mismatch` ou `oauth_failed`). **É este passo que exclui o app.**
4. Quem recebe o `code` chama `POST /auth/google/exchange` com
   `{ "code": "..." }`. Com `X-Client-Type: mobile`, a resposta segue o
   formato mobile (`accessToken`, `refreshToken`, `user`). O código vale 60
   segundos e uma vez só; usado, expirado ou inexistente: 401
   `Invalid or expired code`; com tamanho diferente de 43: 400.

### Vinculação de conta (afeta o app mesmo sem o login com Google)

Um usuário pode entrar com Google pelo web usando o mesmo email de uma conta
criada no app. O servidor só vincula quando o Google garante o email:

| Situação no servidor                                  | Resultado                                                                 | `hasPassword` |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------- |
| Conta Google já vinculada                             | Login direto                                                              | inalterado    |
| Conta local com o mesmo email, `emailVerified: true`  | Vincula; senha e sessões continuam valendo                                | inalterado (`true`) |
| Conta local com o mesmo email, `emailVerified: false` | Apaga a senha e **todas** as sessões da conta, depois vincula             | `false`       |
| Nenhuma conta                                         | Cria conta sem senha                                                      | `false`       |

O caso que importa para o app é o terceiro (toda conta criada no app tem
`emailVerified: false`). Depois dele:

- o login por senha dessa conta responde **401 `Invalid credentials`**;
- o refresh token salvo no app recebe **401 `Invalid refresh token`**: sessão
  encerrada, mostre o login;
- o access token que o app já tinha vale até expirar;
- `hasPassword` passa a `false`, e não existe fluxo para definir senha nova:
  essa conta só entra pelo Google, que o app ainda não suporta.

## Erros

Todo erro sai neste formato:

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "Invalid refresh token",
  "path": "/auth/refresh",
  "timestamp": "2026-10-05T20:58:57.219Z"
}
```

| Campo        | Tipo                           | Observação                                                     |
| ------------ | ------------------------------ | -------------------------------------------------------------- |
| `statusCode` | número                         | Igual ao status HTTP. É o que o app usa para decidir           |
| `error`      | string                         | Nome do status (`Bad Request`, `Unauthorized`...)              |
| `message`    | string **ou** array de strings | Array nos erros de validação de campos; string nos demais      |
| `path`       | string                         | Caminho da request, com a query string se houver               |
| `timestamp`  | string (ISO 8601)              | Momento do erro                                                |

Em Kotlin, modele `message` como um tipo que aceite os dois formatos (por
exemplo, um `JsonElement`, ou um serializer que transforme string em lista de
um item). As mensagens de auth estão em inglês e não são textos de
interface: mostre mensagens próprias. Elas aparecem abaixo para depuração e
testes, não para o app comparar.

**Ordem das checagens** (a primeira que falha responde): rate limit (429) →
Bearer, nas rotas protegidas (401) → JSON malformado (400) → `X-Client-Type`
(400) → campos do corpo (400) → canal do refresh token (400) → regra de
negócio (400, 401, 404, 409, 429 por conta).

### Por rota

Além dos casos abaixo, toda rota com `X-Client-Type` obrigatório pode
responder os dois 400 do header, e toda rota pode responder 429
`ThrottlerException: Too Many Requests`. JSON malformado dá 400 com a
mensagem do parser (string).

**`POST /auth/signup`**

| Status | `message`                                                                                     | Quando                                         |
| ------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 400    | `["email must be an email"]`                                                                  | Email inválido                                 |
| 400    | `["password must be longer than or equal to 8 characters"]`                                   | Senha curta                                    |
| 400    | `["password must be shorter than or equal to 128 characters"]`                                | Senha com mais de 128 caracteres               |
| 400    | `["password must be shorter than or equal to 128 characters after Unicode normalization (NFKC)"]` | Até 128 como enviada, mais de 128 depois do NFKC |
| 400    | `["password has appeared in a known data breach; choose a different one"]`                    | Senha vazada                                   |
| 400    | `["name must be shorter than or equal to 100 characters"]`                                    | Nome longo                                     |
| 400    | `["property <campo> should not exist"]`                                                       | Campo desconhecido                             |
| 409    | `Email already registered`                                                                    | Email já cadastrado                            |
| 409    | `Resource already exists`                                                                     | Dois cadastros simultâneos do mesmo email: um 201, os outros 409 com esta mensagem |

**`POST /auth/login`**

| Status | `message`                               | Quando                                                                     |
| ------ | --------------------------------------- | -------------------------------------------------------------------------- |
| 400    | `["email must be an email"]`, `["password must be longer than or equal to 1 characters"]`, `["password must be shorter than or equal to 128 characters"]`, `["property name should not exist"]` | Campos inválidos ou desconhecidos |
| 401    | `Invalid credentials`                   | Senha errada, email inexistente ou conta sem senha (mesma resposta nos três casos) |
| 429    | `ThrottlerException: Too Many Requests` | Limite por IP ou por conta (ver [Rate limit](#rate-limit))                 |

**`POST /auth/refresh`**

| Status | `message`                                                                                                  | Quando                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 400    | `refreshToken cookie must not be sent when X-Client-Type is mobile; send refreshToken in the request body` | Request com o cookie `refreshToken`                          |
| 400    | `["refreshToken must be a jwt string"]`                                                                    | Valor sem formato de JWT                                     |
| 400    | `["property <campo> should not exist"]`                                                                    | Campo desconhecido                                           |
| 401    | `Missing refresh token`                                                                                    | Corpo sem `refreshToken`                                     |
| 401    | `Invalid refresh token`                                                                                    | Qualquer token recusado: assinatura inválida, expirado, desconhecido, encerrado (logout, logout-all, vinculação), usuário apagado ou reuso |

**`POST /auth/logout`**

| Status | `message`                                  | Quando                                                               |
| ------ | ------------------------------------------ | -------------------------------------------------------------------- |
| 204    | —                                          | Token revogado, token já inexistente, ou corpo sem `refreshToken`    |
| 400    | as mesmas do cookie e do `jwt string` de `/auth/refresh` | Cookie presente ou token malformado                  |
| 401    | `Invalid refresh token`                    | JWT com assinatura inválida, adulterado ou expirado                  |

**`POST /auth/logout-all`**

| Status | `message`      | Quando                                                             |
| ------ | -------------- | ------------------------------------------------------------------ |
| 401    | `Unauthorized` | Sem Bearer, ou access token inválido ou expirado (antes do header) |

**`POST /auth/google/exchange`**

| Status | `message`                                                       | Quando                                |
| ------ | --------------------------------------------------------------- | ------------------------------------- |
| 400    | `["code must be longer than or equal to 43 characters"]` (ou `shorter than`) | Tamanho diferente de 43  |
| 401    | `Invalid or expired code`                                       | Código usado, expirado ou inexistente |

**`GET /me`**

| Status | `message`        | Quando                                             |
| ------ | ---------------- | -------------------------------------------------- |
| 401    | `Unauthorized`   | Sem Bearer, ou access token inválido ou expirado   |
| 404    | `User not found` | Access token válido de um usuário que foi apagado  |

Toda rota protegida por Bearer (`/me`, `/auth/logout-all`, `/activities`)
responde o mesmo 401 `Unauthorized` para access token ausente, malformado,
expirado ou emitido por outro servidor.

### O que o app faz em cada status

| Status | Ação                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 400    | Erro do app. Em formulário, mostre uma mensagem própria. Em `X-Client-Type` ou cookie, é bug do cliente HTTP                 |
| 401    | Em rota com Bearer: refresh e repete uma vez. Em `/auth/refresh`: sessão encerrada. Em `/auth/login`: credenciais inválidas |
| 404    | `User not found` em `/me` ou em `POST /activities/import`: usuário apagado, sessão encerrada. Limpe a sessão local e vá para o login; não mostre uma mensagem genérica de "não encontrado" |
| 409    | No cadastro: "email já em uso", para as duas mensagens                                                                       |
| 429    | "Muitas tentativas, aguarde" (com o `Retry-After`). Não refaça a ação automaticamente. Não encerra a sessão                   |
| 5xx    | Erro do servidor. Não encerra a sessão; tente de novo mais tarde                                                             |

## Rate limit

Dois mecanismos, com a mesma resposta: status 429, `message`
`ThrottlerException: Too Many Requests` e o header **`Retry-After`** com os
segundos de espera.

**Por IP e por rota.** Cada rota tem um contador próprio por IP, numa janela
de 1 minuto: 10 em `/auth/signup` e `/auth/login`; 30 em `/auth/refresh` e
`/auth/logout`; 20 em `/auth/google/exchange`, `/auth/logout-all` e
`POST /activities/import`; 100 nas demais (padrão configurável). O rate limit
vem antes de qualquer outra checagem, inclusive do Bearer. `Retry-After`: os
segundos até o contador zerar (até 60 no padrão). Numa rede móvel atrás de
NAT, vários usuários podem dividir o mesmo IP.

**Por conta, no login.** O servidor conta cada tentativa de login por email,
exista ou não a conta, e um login bem-sucedido zera a contagem. Passando de
`LOGIN_MAX_FAILURES` tentativas sem sucesso (padrão 5) dentro de
`LOGIN_FAILURE_WINDOW_MINUTES` (padrão 15, contados da primeira tentativa),
**toda** tentativa para aquele email recebe 429, **mesmo com a senha certa**,
até a janela acabar. Com os padrões: as 5 primeiras senhas erradas dão 401, e
a 6ª tentativa já dá 429 com `Retry-After` de até 900. Não afeta sessões
abertas (`/auth/refresh`) nem outros emails. A resposta é idêntica à do
limite por IP.

Em qualquer 429: mostre "muitas tentativas, aguarde" (pode usar o
`Retry-After` para o tempo), não diga que a conta foi bloqueada, não repita
automaticamente e não limpe a sessão. Um 429 em `/auth/refresh` não é sessão
encerrada: mantenha o refresh token e tente depois. Os headers
`X-RateLimit-*` que às vezes aparecem não fazem parte do contrato.

## Interceptor

Regras que o servidor impõe, em ordem de gravidade:

1. **`/auth/refresh` é de uso único e devolve um par novo.** Substitua o
   access **e** o refresh; guardar o refresh antigo quebra a próxima
   renovação.
2. **Um único refresh em voo.** Refreshes paralelos com o mesmo token esgotam
   a janela de tolerância e encerram a sessão deste aparelho. A tolerância é
   para a resposta perdida, não para refreshes paralelos.
3. **Rotas que não disparam refresh.** Um 401 de `/auth/signup`,
   `/auth/login`, `/auth/refresh`, `/auth/logout` ou `/auth/google/exchange`
   nunca dispara refresh (geraria laço ou esconderia erro de credencial).
   Compare o caminho exato: `/auth/logout-all` usa Bearer e **dispara**
   refresh no 401, como `/me` e `/activities`.
4. **`X-Client-Type: mobile` em toda request, e nenhum cookie.** Não
   configure `CookieJar` no OkHttp.

### Como isso se traduz no OkHttp

Duas peças: um `Interceptor`, que decora toda request, e um `Authenticator`,
que o OkHttp chama quando uma resposta volta com 401.

O **Interceptor** adiciona `X-Client-Type: mobile` a toda request (regra 4)
e, quando existe um access token salvo, `Authorization: Bearer <access>` com o
valor atual do armazenamento seguro.

O **Authenticator**:

- retorna `null` (desiste) se o caminho da request estiver na lista da regra
  3; se a request já foi refeita uma vez (há uma resposta anterior encadeada);
  ou se não houver refresh token salvo;
- protege a renovação com um lock (`Mutex` de coroutines ou `synchronized`).
  As requests que receberem 401 ao mesmo tempo esperam o lock. Ao entrar,
  cada uma compara o access token que usou (o header `Authorization` da
  request original) com o atual no armazenamento; se forem diferentes, outra
  chamada já renovou, e basta refazer a request com o token novo, **sem**
  chamar `/auth/refresh`;
- quando precisa renovar, chama `POST /auth/refresh` com
  `X-Client-Type: mobile` e `{ "refreshToken": "..." }`, num cliente (ou
  chamada) que **não** passa pelo próprio Authenticator;
- em 200, persiste o novo access **e** o novo refresh **antes** de refazer a
  request original (regra 1), e a refaz uma única vez;
- em 401, a sessão acabou: limpa os tokens, retorna `null` e leva ao login
  com a mensagem de sessão expirada;
- em 429 ou 5xx, mantém os tokens salvos, retorna `null` e deixa o erro
  chegar a quem chamou.

#### Erro de rede no refresh

Erro de rede é falha **sem** resposta HTTP (timeout, conexão recusada ou
caída, troca de rede). O servidor pode ter renovado e a resposta se perdido,
então:

1. **Não limpe a sessão** e **mantenha o refresh token que foi enviado**. Não
   há outro: o novo, se existiu, nunca chegou.
2. **Repita `/auth/refresh` com o MESMO refresh token, uma vez, logo em
   seguida**, ainda dentro do lock (sem backoff longo: a repetição precisa cair
   na janela de `REFRESH_GRACE_SECONDS`, 30 s no padrão). Se der certo, siga
   o caminho de sucesso: persista o par e refaça a request original.
3. Se a repetição também falhar por rede, desista da request atual, mantenha
   os tokens salvos e deixe o erro chegar a quem chamou. A próxima tentativa
   (quando a rede voltar) usa o mesmo token. Se o servidor não tinha recebido
   nenhuma das chamadas, ela renova normalmente; se tinha e a janela já
   passou, a resposta é 401 e a sessão termina.
4. Não repita mais de uma vez dentro da janela: a segunda repetição do mesmo
   token conta como reuso e encerra a sessão deste aparelho.

Uma resposta HTTP de erro (5xx, 429) não é erro de rede: a troca do token é
transacional, então o token enviado continua válido. Mantenha-o e tente mais
tarde.

### Inicialização e logout

Ao abrir o app com um refresh token salvo, chame `/auth/refresh` **antes** de
exibir telas protegidas e persista o par devolvido. 401: sessão expirada,
limpe os tokens e mostre o login. Erro de rede: regra do
[erro de rede no refresh](#erro-de-rede-no-refresh). Sem refresh token
salvo, vá direto ao login.

No logout, chame `POST /auth/logout` com `{ "refreshToken": "..." }` e limpe
todo o estado local qualquer que seja a resposta.

Em "sair de todos os dispositivos" (`POST /auth/logout-all`), um 401 por
access token expirado passa pelo `Authenticator` como em qualquer rota com
Bearer (renova e repete). As outras sessões só caem com o 204; limpe o estado
local depois dele.

## O que o cliente não deve assumir

- **Conteúdo do JWT.** Não decodifique os tokens nem dependa das claims
  (`sub`, `exp`, `iss`, `aud` etc.); elas já mudaram e podem mudar de novo.
  Dados do usuário: `user` ou `GET /me`. Expiração: o 401.
- **Texto das mensagens de erro.** Decida pelo `statusCode` e pela rota. As
  mensagens podem mudar, e uma mesma situação pode ter mais de uma (o 409 do
  cadastro tem duas).
- **Formato de `message`.** Pode ser string ou array.
- **Valores fixos.** TTLs, janela de tolerância, limites de rate e do login
  por conta são padrões configuráveis.
- **Refresh token reaproveitável.** Cada refresh token vale uma vez; o
  anterior só serve dentro da janela de tolerância, uma vez.
- **Logout invalidando o access token.** Ele vale até expirar; descarte-o.
- **`hasPassword` imutável.** Pode passar a `false` depois de um login com
  Google feito no web.
- **`name` e `avatarUrl` presentes.** Podem ser `null`.
- **Cookies.** O app não envia nem guarda cookies.
- **Login com Google no app.** Ainda não existe.
- **Swagger em produção.** `/docs` e `/docs-json` não existem lá.

## Lacunas conhecidas

Não implementadas; o app não deve contar com elas:

- **Login nativo com Google** (`POST /auth/google/token` com o `idToken`).
  Hoje só existe o fluxo de redirect, que termina no cliente web.
- **Verificação de email e reset de senha** (dependem de envio de email).
- **Definição de senha para conta sem senha** (`hasPassword: false`).
- **Alteração de perfil** (nome, avatar). `GET /me` é somente leitura.

## Pendências do contrato

Dados de que o app precisa e que este contrato ainda não define; não assuma
valores para eles:

- **URL base de produção** da API.
- **Código de erro estável.** Não há campo de código além de `statusCode`;
  as mensagens acima servem para depuração, não para decidir comportamento.
