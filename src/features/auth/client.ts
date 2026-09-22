import { readFetch } from "./read-fetch";
import { AUTH_CHANNEL, AUTH_EVENT_KEY, SIGNED_OUT_MESSAGE } from "./session-events";
export type AuthUser = { id: string; email: string; name: string; role?: string };
const CSRF_KEY = "otgolosok:account:csrf";
const LAST_USER_KEY = "otgolosok:account:last-user";

async function api(path: string, init?: RequestInit) {
  const csrf = typeof sessionStorage === "undefined" ? "" : sessionStorage.getItem(CSRF_KEY) ?? "";
  const response = await ((!init?.method || init.method === "GET") ? readFetch : fetch)(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20000), ...init,
    headers: { "Content-Type": "application/json", ...(init?.method && !["GET","HEAD"].includes(init.method) && csrf ? {"X-CSRF-Token":csrf} : {}), ...(init?.headers ?? {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.message ?? value?.error?.message ?? "Не удалось выполнить запрос.");
  return value;
}
export async function getSession(): Promise<AuthUser | null> {
  if(typeof localStorage!=="undefined"&&localStorage.getItem("otgolosok:auth:offline-logout"))return null;
  const response = await readFetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok && response.status !== 401) throw new Error("Не удалось проверить вход. Попробуйте ещё раз.");
  if (!response.ok) {
    localStorage.removeItem(LAST_USER_KEY);
    return null;
  }
  const value=await response.json();
  if(value.csrfToken)sessionStorage.setItem(CSRF_KEY,value.csrfToken);
  if(value.user?.id) localStorage.setItem(LAST_USER_KEY,value.user.id); else localStorage.removeItem(LAST_USER_KEY);
  return value.user ?? null;
}
export const getLastUserId = () => typeof localStorage === "undefined" ? null : localStorage.getItem(LAST_USER_KEY);
async function completeAuthentication(path:string,body:Record<string,string>,message:string){try{const value=await api(path,{method:"POST",body:JSON.stringify(body)});localStorage.removeItem("otgolosok:auth:offline-logout");await getSession();return value;}catch(error){throw new Error(message,{cause:error});}}
export const signInWithPassword = (email:string,password:string) => completeAuthentication("/api/auth/sign-in/email",{email,password},"Неверный email или пароль.");
export const signUpWithPassword = (name:string,email:string,password:string) => completeAuthentication("/api/auth/sign-up/email",{name,email,password},"Не удалось создать аккаунт. Возможно, этот email уже используется.");
function announceSignOut(){try{new BroadcastChannel(AUTH_CHANNEL).postMessage(SIGNED_OUT_MESSAGE);}catch{/* Storage remains the cross-tab fallback. */}localStorage.setItem(AUTH_EVENT_KEY,String(Date.now()));}
async function revokePending(){if(!localStorage.getItem("otgolosok:auth:offline-logout"))return;await api("/api/auth/sign-out",{method:"POST",body:"{}"});localStorage.removeItem("otgolosok:auth:offline-logout");}
if(typeof window!=="undefined"){addEventListener("online",()=>void revokePending().catch(()=>{}));void revokePending().catch(()=>{});}
export const signOut = async () => {
  try {
    const result = await api("/api/auth/sign-out", { method: "POST", body: "{}" });
    localStorage.removeItem("otgolosok:auth:offline-logout");
    return result;
  } catch (error) {
    localStorage.setItem("otgolosok:auth:offline-logout", String(Date.now()));
    throw new Error("Локальный выход выполнен. Сервер отзовёт сессию после восстановления сети.", { cause: error });
  } finally {
    sessionStorage.removeItem(CSRF_KEY);
    localStorage.removeItem(LAST_USER_KEY);
    announceSignOut();
  }
};
export const signOutEverywhere = async () => {const result=await api("/api/auth/revoke-sessions", { method:"POST", body:"{}" });localStorage.removeItem(LAST_USER_KEY);announceSignOut();return result;};
export const csrfHeaders = (): Record<string,string> => {const token=typeof sessionStorage==="undefined"?null:sessionStorage.getItem(CSRF_KEY);return token?{"X-CSRF-Token":token}:{};};
export { api as accountApi };
