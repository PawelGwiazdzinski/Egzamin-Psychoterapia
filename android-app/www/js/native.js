// Most do natywnej wtyczki Androida "Lektor" (TTS, OCR ML Kit, logowanie Google, HTTP).
// W zwykłej przeglądarce (test na komputerze) używa zamienników webowych.

const Cap = window.Capacitor;
export const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
export const Lektor = isNative ? Cap.registerPlugin("Lektor") : null;
const Http = isNative ? Cap.Plugins.CapacitorHttp : null;

/** Żądanie HTTP bez ograniczeń CORS (natywnie) albo zwykły fetch (przeglądarka). */
export async function http({ url, method = "GET", headers = {}, data, responseType = "json" }) {
  if (Http) {
    const r = await Http.request({ url, method, headers, data, responseType, connectTimeout: 30000, readTimeout: 600000 });
    if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${typeof r.data === "string" ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300)}`);
    return r.data;
  }
  const r = await fetch(url, { method, headers, body: data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return responseType === "json" ? r.json() : r.text();
}

/** Token dostępu Google (natywne okno konta Google na telefonie). */
export async function googleToken(interactive = true) {
  const scopes = ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive.file"];
  if (Lektor) {
    const r = await Lektor.googleAuthorize({ scopes, interactive });
    return r.accessToken;
  }
  // przeglądarka: Google Identity Services (wymaga clientId typu Web w localStorage "lektor.webClientId")
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
