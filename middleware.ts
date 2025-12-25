import { NextResponse } from "next/server";

export function middleware(request: Request) {
  // Retrieve the origin from the request headers
  const origin = request.headers.get("origin");

  // Define allowed origins (Your Shopify domain)
  // You can use "*" for development, but specific domain is safer
  const allowedOrigin = "https://loamlabsusa.com";

  // Check if the origin is allowed (or if it's null/server-to-server)
  const isAllowed = origin === allowedOrigin || !origin;

  // Prepare the response
  const response = NextResponse.next();

  if (isAllowed) {
    response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }

  return response;
}

export const config = {
  matcher: "/api/:path*",
};