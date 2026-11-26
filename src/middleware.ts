import { NextResponse, type NextRequest } from "next/server";

// Everything except the public chat (/ and /api/chat) needs the admin password.
export const config = { matcher: ["/panel/:path*", "/api/((?!chat$).*)"] };

export function middleware(req: NextRequest) {
  // The browser sends saved passwords to us even from other websites, so block those writes.
  if (!["GET", "HEAD"].includes(req.method) && req.headers.get("sec-fetch-site") === "cross-site") {
    return new NextResponse("Permintaan dari situs lain ditolak.", { status: 403 });
  }

  // Next.js cuts bodies above middlewareClientMaxBodySize (next.config.ts) and the upload then hangs.
  if (Number(req.headers.get("content-length") ?? 0) > 51 * 1024 * 1024) {
    return NextResponse.json({ detail: "Ukuran berkas melebihi 50 MB." }, { status: 413 });
  }

  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return new NextResponse(
      "Panel terkunci: isi ADMIN_PASSWORD di file .env.local, lalu jalankan ulang frontend.",
      { status: 503 }
    );
  }

  // Any username is accepted; only the password is checked.
  const [scheme, encoded] = (req.headers.get("authorization") ?? "").split(" ");
  if (scheme === "Basic" && encoded) {
    try {
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
      );
      if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
    } catch {
      // malformed header: ask again
    }
  }
  return new NextResponse("Perlu kata sandi admin.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="SuraLake Panel", charset="UTF-8"' },
  });
}
