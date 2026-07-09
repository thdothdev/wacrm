import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEFAULT_LOCALE, LOCALE_COOKIE, isAppLocale } from "@/i18n/locales";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const locale =
    body && typeof body === "object" && "locale" in body
      ? String((body as { locale: unknown }).locale)
      : null;

  if (!isAppLocale(locale)) {
    return NextResponse.json({ error: "Unsupported locale" }, { status: 400 });
  }

  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return NextResponse.json({
    locale,
    defaultLocale: DEFAULT_LOCALE,
  });
}