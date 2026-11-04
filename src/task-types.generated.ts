// Generated from the SurSolver catalog (GET /v1/task-types) by the spec repository
// tools/templates/npm.ts. Catalog fetched at 2026-11-03T21:16:22.334Z. Do not edit.

/** Every accepted `task.type` spelling: canonical names, ProxyLess twins and aliases. */
export const TaskType = {
  AkamaiBmpTask: 'AkamaiBmpTask',
  AkamaiCookie: 'AkamaiCookie',
  AkamaiCookieProxyLess: 'AkamaiCookieProxyLess',
  AkamaiSbsdCookie: 'AkamaiSbsdCookie',
  AltchaToken: 'AltchaToken',
  AltchaTokenProxyLess: 'AltchaTokenProxyLess',
  AwsCaptchaCookie: 'AwsCaptchaCookie',
  AwsChallengeCookie: 'AwsChallengeCookie',
  CaptchaFoxToken: 'CaptchaFoxToken',
  CastleAndroidToken: 'CastleAndroidToken',
  CastleToken: 'CastleToken',
  CastleWebToken: 'CastleWebToken',
  CloudflareChallengeCookie: 'CloudflareChallengeCookie',
  DataDomeSliderCookie: 'DataDomeSliderCookie',
  FriendlyCaptchaToken: 'FriendlyCaptchaToken',
  FriendlyCaptchaTokenProxyLess: 'FriendlyCaptchaTokenProxyLess',
  GeeTestToken: 'GeeTestToken',
  GeeTestTokenProxyLess: 'GeeTestTokenProxyLess',
  GeeTestV3Token: 'GeeTestV3Token',
  GeeTestV4Token: 'GeeTestV4Token',
  ImageToText: 'ImageToText',
  ImageToTextTask: 'ImageToTextTask',
  ImpervaCookie: 'ImpervaCookie',
  ImpervaUtmvcCookie: 'ImpervaUtmvcCookie',
  KasadaToken: 'KasadaToken',
  KasadaTokenProxyLess: 'KasadaTokenProxyLess',
  LeminToken: 'LeminToken',
  LeminTokenProxyLess: 'LeminTokenProxyLess',
  MtCaptchaToken: 'MtCaptchaToken',
  MtCaptchaTokenProxyLess: 'MtCaptchaTokenProxyLess',
  PerimeterXCookie: 'PerimeterXCookie',
  ProsopoToken: 'ProsopoToken',
  ProsopoTokenProxyLess: 'ProsopoTokenProxyLess',
  ReCaptchaV2EnterpriseToken: 'ReCaptchaV2EnterpriseToken',
  ReCaptchaV2EnterpriseTokenProxyLess: 'ReCaptchaV2EnterpriseTokenProxyLess',
  ReCaptchaV2Token: 'ReCaptchaV2Token',
  ReCaptchaV2TokenProxyLess: 'ReCaptchaV2TokenProxyLess',
  ReCaptchaV3EnterpriseToken: 'ReCaptchaV3EnterpriseToken',
  ReCaptchaV3EnterpriseTokenProxyLess: 'ReCaptchaV3EnterpriseTokenProxyLess',
  ReCaptchaV3Token: 'ReCaptchaV3Token',
  ReCaptchaV3TokenProxyLess: 'ReCaptchaV3TokenProxyLess',
  ShapeCookie: 'ShapeCookie',
  ShapeCookieProxyLess: 'ShapeCookieProxyLess',
  TurnstileToken: 'TurnstileToken',
  TurnstileTokenProxyLess: 'TurnstileTokenProxyLess',
  VercelCookie: 'VercelCookie',
} as const;

export type TaskTypeName = (typeof TaskType)[keyof typeof TaskType];

/** The complete `errorCode` vocabulary of the solver endpoints. */
export const ERROR_CODES = [
  'ERROR_KEY_DOES_NOT_EXIST',
  'ERROR_WRONG_CLIENT_KEY',
  'ERROR_ZERO_BALANCE',
  'ERROR_NO_SLOT_AVAILABLE',
  'ERROR_TYPE_NOT_SUPPORTED',
  'ERROR_TASK_NOT_FOUND',
  'ERROR_TASK_EXPIRED',
  'ERROR_TASK_TIMEOUT',
  'ERROR_FAILED',
  'ERROR_INVALID_REQUEST',
  'ERROR_WRONG_USERAGENT',
  'ERROR_INTERNAL_ERROR',
] as const;

export type KnownErrorCode = (typeof ERROR_CODES)[number];
