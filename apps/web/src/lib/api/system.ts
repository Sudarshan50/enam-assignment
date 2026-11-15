import { USE_MOCKS } from "@/lib/env";
import { parseMock, request, requestVoid } from "./http";
import { mocks } from "./mock";
import { EngineResponseSchema, PrefsSchema, VapidKeyResponseSchema, type Prefs } from "./schemas";

export async function getEngine() {
  if (USE_MOCKS) return parseMock(EngineResponseSchema, (await mocks()).engine(), "engine");
  return request("/engine", EngineResponseSchema);
}

export async function getPrefs() {
  if (USE_MOCKS) return parseMock(PrefsSchema, (await mocks(false)).prefs(), "prefs");
  return request("/prefs", PrefsSchema);
}

export async function savePrefs(prefs: Prefs) {
  if (USE_MOCKS) return parseMock(PrefsSchema, (await mocks(false)).savePrefs(prefs), "prefs");
  return request("/prefs", PrefsSchema, { method: "PUT", body: prefs });
}

export async function getVapidKey() {
  if (USE_MOCKS) return parseMock(VapidKeyResponseSchema, (await mocks(false)).vapidKey(), "vapid");
  return request("/push/vapid-public-key", VapidKeyResponseSchema);
}

export async function savePushSubscription(subscription: PushSubscriptionJSON) {
  if (USE_MOCKS) return;
  return requestVoid("/push-subscriptions", { method: "POST", body: subscription });
}

export async function deletePushSubscription(endpoint: string) {
  if (USE_MOCKS) return;
  return requestVoid("/push-subscriptions", { method: "DELETE", body: { endpoint } });
}
