import { NextResponse } from "next/server";

export function middleware(request: Request) {
  const origin = request.headers.get("origin");
  console.log("Middleware Origin Check:", origin); // Log for Vercel

  const response = NextResponse.next();

  // Allow any origin for now to debug the 405
  response.headers.set("Access-Control-Allow-Origin", origin || "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.headers.set("Access-Control-Allow-Credentials", "true");

  // Handle preflight explicitly in middleware
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 200,
      headers: response.headers,
    });
  }

  return response;
}

export const config = {
  matcher: "/api/:path*",
};