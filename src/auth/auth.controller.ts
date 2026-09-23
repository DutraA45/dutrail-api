import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Redirect,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator.js';
import { ErrorResponseDto } from '../common/dto/error-response.dto.js';
import { EnvironmentVariables } from '../config/env.validation.js';
import type { User } from '../generated/prisma/client.js';
import { AuthService } from './auth.service.js';
import { AuthResponseDto, TokenPairDto } from './dto/auth-response.dto.js';
import { ExchangeCodeDto } from './dto/exchange-code.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { SignupDto } from './dto/signup.dto.js';
import { GoogleAuthGuard } from './guards/google-auth.guard.js';

/**
 * Limite mais apertado para rotas que aceitam credenciais: dificulta força
 * bruta e "credential stuffing". O limite global (THROTTLE_*) continua
 * valendo para o resto da API.
 */
const CREDENTIALS_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

// Todas as rotas deste controller são @Public(): quem "autentica" aqui é a
// própria credencial enviada (senha, refresh token, código do Google).
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  @Public()
  @Post('signup')
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: 'Cadastro com email e senha' })
  @ApiCreatedResponse({
    description: 'Usuário criado; já retorna os tokens.',
    type: AuthResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Body inválido',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'Email já cadastrado',
    type: ErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit excedido',
    type: ErrorResponseDto,
  })
  async signup(@Body() dto: SignupDto): Promise<AuthResponseDto> {
    const result = await this.authService.signup(
      dto.email,
      dto.password,
      dto.name,
    );
    return AuthResponseDto.fromResult(result);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: 'Login com email e senha' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({
    description: 'Body inválido',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Credenciais inválidas',
    type: ErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit excedido',
    type: ErrorResponseDto,
  })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    const result = await this.authService.login(dto.email, dto.password);
    return AuthResponseDto.fromResult(result);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Troca um refresh token por um novo par de tokens',
    description:
      'O refresh token enviado é invalidado (rotação). Reapresentar um token já usado ' +
      'revoga todas as sessões do usuário.',
  })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiBadRequestResponse({
    description: 'Body inválido',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Refresh token inválido, expirado ou revogado',
    type: ErrorResponseDto,
  })
  async refresh(@Body() dto: RefreshTokenDto): Promise<TokenPairDto> {
    const tokens = await this.authService.refresh(dto.refreshToken);
    return TokenPairDto.fromTokens(tokens);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Invalida o refresh token atual',
    description:
      'O access token continua válido até expirar (é stateless); o cliente deve descartá-lo.',
  })
  @ApiNoContentResponse({
    description: 'Refresh token revogado (ou já estava)',
  })
  @ApiBadRequestResponse({
    description: 'Body inválido',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Refresh token com assinatura inválida',
    type: ErrorResponseDto,
  })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  /**
   * O guard faz tudo: a GoogleStrategy responde com um 302 para o Google e o
   * corpo deste método nunca executa.
   */
  @Public()
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({
    summary: 'Inicia o login com Google',
    description:
      'Abra esta URL no browser; ela redireciona para a tela de consentimento do Google.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect para accounts.google.com',
  })
  googleLogin(): void {}

  /**
   * URL cadastrada no Google Console. Aqui o guard já rodou a strategy e
   * `req.user` é o usuário criado/vinculado. Em vez de colocar tokens na URL
   * (histórico do browser, logs de proxy), geramos um código de uso único e
   * o frontend o troca por tokens em POST /auth/google/exchange.
   */
  @Public()
  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiExcludeEndpoint() // chamado só pelo Google; não faz sentido no Swagger
  async googleCallback(
    @Req() req: Request & { user: User },
  ): Promise<{ url: string }> {
    const code = await this.authService.createExchangeCode(req.user.id);
    const frontend = this.config.get('FRONTEND_URL', { infer: true });
    return {
      url: `${frontend}/auth/callback?code=${encodeURIComponent(code)}`,
    };
  }

  @Public()
  @Post('google/exchange')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Troca o código do callback do Google por tokens' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({
    description: 'Body inválido',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Código inválido, expirado ou já usado',
    type: ErrorResponseDto,
  })
  async googleExchange(@Body() dto: ExchangeCodeDto): Promise<AuthResponseDto> {
    const result = await this.authService.exchangeCode(dto.code);
    return AuthResponseDto.fromResult(result);
  }
}
