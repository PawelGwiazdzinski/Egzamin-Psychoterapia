// Most do natywnej wtyczki Androida "Lektor" (czytanie, OCR ML Kit, logowanie Google, pliki z zewnątrz).
// W zwykłej przeglądarce (testy na komputerze) część funkcji ma zamienniki webowe.

const Cap = window.Capacitor;
export const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
export const Lektor = isNative ? Cap.registerPlugin("Lektor") : null;
const Http = isNative ? Cap.Plugins.CapacitorHttp : null;
const ShareP = isNative ? Cap.Plugins.Share : null;
const AppP = isNative ? Cap.Plugins.App : null;

/** Żądanie HTTP bez ograniczeń CORS (natywnie) albo zwykły fetch (przeglądarka). */
export async function http({ url, method = "GET", headers = {}, data, responseType = "json", timeout = 60000 }) {
  if (Http) {
    const r = await Http.request({ url, method, headers, data, responseType, connectTimeout: 30000, readTimeout: timeout });
    if (r.status >= 400) {
      const body = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
      throw new Error(`HTTP ${r.status}: ${String(body).slice(0, 300)}`);
    }
    if (responseType === "json" && typeof r.data === "string") {
      try { return JSON.parse(r.data); } catch { return r.data; }
    }
    return r.data;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { method, headers, signal: ctrl.signal,
      body: data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data) });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    if (responseType === "json") {
      const txt = await r.text();
      try { return JSON.parse(txt); } catch { return txt; }
    }
    return r.text();
  } finally { clearTimeout(t); }
}

/** Udostępnianie tekstu / pliku przez systemowy arkusz udostępniania. */
export async function share({ title, text, url }) {
  if (ShareP) return ShareP.share({ title, text, url, dialogTitle: title });
  if (navigator.share) return navigator.share({ title, text, url });
  await navigator.clipboard.writeText(text || url || "");
  return { clipboard: true };
}

export function onBackButton(cb) {
  AppP?.addListener("backButton", cb);
}
export function minimizeApp() {
  AppP?.minimizeApp();
}
export function openExternal(url) {
  window.open(url, "_system") || window.open(url, "_blank");
}

/** Token dostępu Google (opcjonalna ścieżka OAuth; natywne okno konta Google). */
export async function googleToken(interactive = true) {
  const scopes = ["https://www.googleapis.com/auth/documents"];
  if (Lektor) {
    const r = await Lektor.googleAuthorize({ scopes, interactive });
    return r.accessToken;
  }
  const clientId = localStorage.getItem("lektor.webClientId");
  if (!clientId) throw new Error("W przeglądarce ustaw localStorage 'lektor.webClientId' (OAuth client typu Web).");
  if (!window.google?.accounts) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  return new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: scopes.join(" "),
      callback: (r) => (r.error ? rej(new Error(r.error)) : res(r.access_token)),
    });
    tc.requestAccessToken({ prompt: interactive ? "" : "none" });
  });
}

/** OCR ML Kit (na urządzeniu, offline). Zwraca słowa z ramkami w pikselach obrazu. */
export async function mlkitOcr(b64png) {
  if (!Lektor) throw new Error("OCR ML Kit działa tylko w aplikacji na Androidzie");
  return Lektor.ocr({ image: b64png });
}
