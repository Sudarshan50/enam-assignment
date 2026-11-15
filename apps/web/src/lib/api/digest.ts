import { DigestItemSchema, DigestResponseSchema } from "@finn/shared";
import { USE_MOCKS } from "@/lib/env";
import { parseMock, request, requestVoid } from "./http";
import { mocks } from "./mock";

export type DigestWindow = "24h" | "3d" | "7d";
export type InteractionAction = "open" | "dismiss" | "undo_dismiss" | "pin";

export async function getDigest(window: DigestWindow) {
  if (USE_MOCKS) return parseMock(DigestResponseSchema, (await mocks()).digest(window), "digest");
  return request(`/digest?window=${window}`, DigestResponseSchema);
}

export async function getAnnouncement(seqId: string) {
  if (USE_MOCKS) return parseMock(DigestItemSchema.nullable(), (await mocks()).announcement(seqId), "announcement");
  return request(`/announcements/${encodeURIComponent(seqId)}`, DigestItemSchema);
}

export async function recordInteraction(seqId: string, action: InteractionAction) {
  if (USE_MOCKS) return;
  return requestVoid("/interactions", { method: "POST", body: { seqId, action } });
}
