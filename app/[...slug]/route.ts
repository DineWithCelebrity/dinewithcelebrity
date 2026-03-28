import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

interface Context {
  params: Promise<{ slug: string[] }>;
}

export async function GET(request: Request, context: Context) {
  const { slug } = await context.params;
  const filename = slug.join('/') + '.html';
  const filePath = path.join(process.cwd(), 'public', filename);
  
  try {
    const html = fs.readFileSync(filePath, 'utf-8');
    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
