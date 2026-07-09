export const DEFAULT_LOCALE = "en";
export const LOCALE_COOKIE = "wacrm.locale";

export const SUPPORTED_LOCALES = [
  { code: "en", label: "English" },
  { code: "pt-BR", label: "Portugues (Brasil)" },
] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]["code"];

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return SUPPORTED_LOCALES.some((locale) => locale.code === value);
}