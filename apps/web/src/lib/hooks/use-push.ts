"use client";

import { useCallback, useEffect, useState } from "react";
import { systemApi } from "@/lib/api";
import { USE_MOCKS } from "@/lib/env";

export type PushState = "checking" | "unsupported" | "ios-needs-install" | "denied" | "off" | "on" | "working";

const MOCK_FLAG = "finn:mock-push";

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  return existing ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Web Push opt-in. iOS only allows push once FINN is installed to the Home Screen (16.4+). */
export function usePush() {
  const [state, setState] = useState<PushState>("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (isIos() && !isStandalone()) return setState("ios-needs-install");
    if (!supported) return setState("unsupported");
    if (Notification.permission === "denied") return setState("denied");
    if (USE_MOCKS) return setState(localStorage.getItem(MOCK_FLAG) === "1" && Notification.permission === "granted" ? "on" : "off");
    void navigator.serviceWorker
      .getRegistration("/")
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setState(sub ? "on" : "off"))
      .catch(() => setState("off"));
  }, []);

  const enable = useCallback(async () => {
    setError(null);
    setState("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setState(permission === "denied" ? "denied" : "off");
      const reg = await registration();
      await navigator.serviceWorker.ready;
      if (USE_MOCKS) {
        localStorage.setItem(MOCK_FLAG, "1");
        await reg.showNotification("FINN alerts are on", {
          body: "You'll hear about results, management changes and unusual moves — nothing else.",
          icon: "/pwa-icon/192",
          badge: "/pwa-icon/96",
          tag: "finn-welcome",
        });
        return setState("on");
      }
      const key = await systemApi.getVapidKey();
      if (!key) throw new Error("Notifications aren't set up on this server yet");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) });
      await systemApi.savePushSubscription(sub.toJSON());
      setState("on");
    } catch (e) {
      setError((e as Error).message || "Couldn't turn on notifications");
      setState("off");
    }
  }, []);

  const disable = useCallback(async () => {
    setError(null);
    setState("working");
    try {
      if (USE_MOCKS) {
        localStorage.removeItem(MOCK_FLAG);
        return setState("off");
      }
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await systemApi.deletePushSubscription(sub.endpoint).catch(() => {});
        await sub.unsubscribe();
      }
      setState("off");
    } catch (e) {
      setError((e as Error).message);
      setState("on");
    }
  }, []);

  return { state, error, enable, disable };
}
