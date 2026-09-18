import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { setSessionPinned } from "@/lib/session-pins";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await parseJsonWithinLimit(request, 1024) as { pinned?: unknown } | null;
    if (!body || typeof body.pinned !== "boolean") {
      return NextResponse.json({ error: "pinned must be a boolean" }, { status: 400 });
    }
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const pinnedSessionIds = setSessionPinned(id, body.pinned);
    return NextResponse.json({ pinnedSessionIds }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Request too large" }, { status: 413 });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    console.error("[session-pin]", error);
    return NextResponse.json({ error: "Unable to save session pin" }, { status: 500 });
  }
}
