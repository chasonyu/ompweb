import type { AgentMessage } from "./types";
import { isUserTurnMessage } from "./user-turn";

/**
 * Fork targets for the message transcript.
 *
 * omp's `branch` RPC command — what the UI calls "fork" / "New session" —
 * only accepts a **user** message entry. Verified against a live
 * `omp --mode rpc-ui`: branching at an assistant entry answers
 * `success:false, error:"Invalid entry ID for branching"`, while the same
 * command at the user entry of the same turn succeeds and returns the
 * selected prompt text.
 *
 * The UI therefore offers the action on every message but resolves each one to
 * the branch point omp supports: a user message forks at itself, an assistant
 * reply forks at the user prompt that started its turn — so the newest reply in
 * a conversation is forkable like the prompt above it (issue #103). Messages
 * with no earlier user entry have no fork target.
 */

export function resolveForkEntryIds(
  messages: readonly AgentMessage[],
  entryIds: readonly (string | undefined)[],
): (string | undefined)[] {
  let lastUserEntryId: string | undefined;
  return messages.map((message, index) => {
    if (isUserTurnMessage(message)) {
      // OMP branch accepts only ordinary user entries, not skill/collab custom entries.
      lastUserEntryId = message.role === "user" ? entryIds[index] : undefined;
      return lastUserEntryId;
    }
    return message.role === "assistant" ? lastUserEntryId : undefined;
  });
}
