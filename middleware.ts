import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const HTML_PAGES = [
  'dashboard','onboarding','signup','signin','upgrade',
  'gives-back','admin-dashboard','events','partner-restaurant',
  'partner-signup','disclaimer','refund','admin-partners',
  'partner-sponsor','stars'
];

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname.replace(/^\//, '').replace(/\.html$/, '');
  if (HTML_PAGES.includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/' + pathname + '.html';
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard', '/onboarding', '/signup', '/signin', '/upgrade',
    '/gives-back', '/admin-dashboard', '/events', '/partner-restaurant',
    '/partner-signup', '/disclaimer', '/refund', '/admin-partners',
    '/partner-sponsor', '/stars'
  ]
};
