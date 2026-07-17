import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function proxy(request: NextRequest) {
  // No auth locally so `npm run dev` never locks you out of your own machine.
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASSWORD;
  // Fail closed: an unconfigured hosted deploy must never be open. If either
  // credential is missing we reject every request rather than compare against "".
  if (expectedUser && expectedPass) {
    const header = request.headers.get("authorization");
    if (header?.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const user = decoded.slice(0, separator);
      const pass = decoded.slice(separator + 1);
      if (safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)) {
        return NextResponse.next();
      }
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Restricted", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!api/cron|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
