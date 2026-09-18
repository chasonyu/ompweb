import { NextResponse } from "next/server";
import { resolveSessionPathOr404, apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { setSessionPinned } from "@/lib/session-pins";
import { isRecord } from "@/lib/type-guards";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(req, 1024);
  } catch (error) {
    return apiErrorResponse(error, error instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  if (!isRecord(body) || typeof body.pinned !== "boolean") {
    return NextResponse.json({ error: "pinned must be a boolean" }, { status: 400 });
  }
  try {
    const { id } = await params;
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const pinnedAt = setSessionPinned(id, body.pinned);
    return NextResponse.json({ pinnedAt: pinnedAt ?? null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
