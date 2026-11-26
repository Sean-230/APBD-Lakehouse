import { NextResponse, type NextRequest } from "next/server";

// No login for now: the panel (/panel) and the chatbot (/) are both open.
// These checks are not a login; they only protect the API.
export const config = { matcher: ["/api/:path*"] };

export function middleware(req: NextRequest) {
  // Stop other websites from making a visitor's browser change or delete data here.
  if (!["GET", "HEAD"].includes(req.method) && req.headers.get("sec-fetch-site") === "cross-site") {
    return new NextResponse("Permintaan dari situs lain ditolak.", { status: 403 });
  }

  // Next.js cuts bodies above middlewareClientMaxBodySize (next.config.ts) and the upload then hangs.
  if (Number(req.headers.get("content-length") ?? 0) > 51 * 1024 * 1024) {
    return NextResponse.json({ detail: "Ukuran berkas melebihi 50 MB." }, { status: 413 });
  }

  return NextResponse.next();
}
