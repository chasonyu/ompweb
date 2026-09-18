import { NextResponse } from "next/server";
import { scanSessionInfo, setSessionTitle, readFirstUserMessage } from "@/lib/omp/session-files";
import { deriveSessionTitleFromFirstMessage, sanitizeSessionTitle } from "@/lib/session-title";
import { getRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionCaches } from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";

/**
 * POST /api/sessions/[id]/auto-name
 *
 * Preserve an existing live/stored title; otherwise derive one from the first
 * real user message. RPC disables native auto-titling, so persist through the
 * live child when present and through the title slot otherwise.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // Running session: ask the live omp process (its in-memory title is newer
    // than the file's slot while a rewrite is pending). This runs before the
    // path check because omp does not create the session file until the history
    // holds an assistant message.
    const rpc = getRpcSession(id);
    const running = Boolean(rpc?.isAlive?.());
    if (running && typeof rpc?.send === "function") {
      try {
        const state = await rpc.send({ type: "get_state" }) as { sessionName?: string } | null;
        const liveTitle = sanitizeSessionTitle(state?.sessionName);
        if (liveTitle) {
          // The live child owns the file; ask it for the path so the targeted
          // invalidation does not flush every other session's parse caches.
          const filePath = rpc?.sessionFile;
          invalidateSessionCaches(filePath);
          return NextResponse.json({ title: liveTitle, usage: null });
        }
      } catch {
        // Fall through to the on-disk title.
      }
    }

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const info = scanSessionInfo(filePath, false);
    const storedTitle = sanitizeSessionTitle(info?.title);
    if (storedTitle) {
      return NextResponse.json({ title: storedTitle, usage: null });
    }

    // Do not trust the list preview: it is only a 4 KiB prefix and can
    // even fall back to developer/assistant text. Naming needs a real user.
    const derived = deriveSessionTitleFromFirstMessage(readFirstUserMessage(filePath));
    if (!derived) {
      return NextResponse.json(
        { error: "The session has no user messages to name", code: "session_no_messages_to_name" },
        { status: 409 },
      );
    }

    // RPC disables native auto-titling. Let the live process own persistence
    // rather than writing behind its back and losing the title on its flush.
    if (running && rpc) {
      await rpc.send({ type: "set_session_name", name: derived });
    } else {
      setSessionTitle(filePath, derived, "auto");
    }
    invalidateSessionCaches(filePath);
    return NextResponse.json({ title: derived, usage: null });
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: "Session file is too large to name", code: "session_file_too_large" }, { status: 413 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
