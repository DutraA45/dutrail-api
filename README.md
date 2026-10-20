# Dutrail API

API do Dutrail, um app para registrar e acompanhar atividades ao ar livre.

> Projeto pessoal, publicado como portfólio. Não aceita contribuições externas
> e não há garantia de estabilidade para terceiros.

## Stack

- [NestJS](https://nestjs.com/) e TypeScript
- PostgreSQL com [Prisma](https://www.prisma.io/)
- Autenticação com Passport e JWT; senhas com Argon2id
- Testes com [Vitest](https://vitest.dev/) (unitários e e2e)
- Cliente web em Angular (em outro repositório)

## Funcionalidades

- Cadastro e login com email e senha, e login com Google (OAuth 2.0)
- Sessões com access token curto e refresh token rotativo, entregue em cookie
  httpOnly (web) ou no corpo da resposta (mobile)
- Importação de atividades a partir de arquivos `.fit` (Garmin e compatíveis)
- Listagem paginada e detalhe das atividades do usuário

## Como rodar localmente

Pré-requisitos: Node.js 24, npm e Docker ou Podman com Compose.

```bash
npm ci                       # instala e gera o Prisma Client
cp .env.example .env         # depois ajuste o .env (veja abaixo)
docker compose up -d         # ou: podman compose up -d
npm run prisma:deploy        # aplica as migrations
npm run start:dev
```

No `.env`, aponte o `DATABASE_URL` para o Postgres do Compose (a URL está
comentada no próprio `.env.example`) e gere segredos JWT próprios com o
comando indicado no arquivo. As credenciais do Google e do object storage só
são necessárias para o login com Google e para a importação de `.fit`.

O Compose sobe um PostgreSQL 17 escutando só em `localhost:5433`, com dois
bancos: `dutrail` (desenvolvimento) e `dutrail_test` (testes e2e).

A API responde em `http://localhost:3000/api`. Fora de produção, a
documentação interativa (Swagger UI) fica em `http://localhost:3000/api/docs`.

## Testes

```bash
npm test             # unitários (não precisam de banco)
npm run test:e2e     # e2e
npm run lint
```

Os testes e2e usam o `.env.test` e o banco `dutrail_test` do Compose, que
precisa estar no ar. As migrations são aplicadas automaticamente antes da
suíte, e as tabelas são esvaziadas a cada teste: nunca aponte o `.env.test`
para um banco com dados que importam. Google, object storage e a checagem de
senhas vazadas são simulados, então os testes não acessam a rede.

## Documentação da API

A especificação OpenAPI está em [`docs/openapi.json`](docs/openapi.json). Ela é
gerada a partir do código por `npm run openapi:generate`.

## Licença

All rights reserved. Veja [LICENSE](LICENSE).
