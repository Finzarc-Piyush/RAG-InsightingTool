import type { PublicClientApplication } from "@azure/msal-browser";

let pca: PublicClientApplication | null = null;

// P-046: Broadcast silent+popup double-failure so UI can surface "session
// expired, sign in again" rather than letting callers hit a cryptic 401.
export const AUTH_TOKEN_FAILED_EVENT = "auth:token-failed";

function emitTokenFailed(reason: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent(AUTH_TOKEN_FAILED_EVENT, { detail: { reason } })
    );
  } catch {
    /* SSR / non-browser contexts: ignore */
  }
}

export function registerMsalInstance(instance: PublicClientApplication): void {
  pca = instance;
}

/**
 * Azure AD ID token for the SPA app — must match server AZURE_AD_CLIENT_ID / AZURE_AD_TENANT_ID.
 */
export async function acquireIdTokenForApi(): Promise<string | null> {
  if (!pca) {
    return null;
  }
  const accounts = pca.getAllAccounts();
  if (accounts.length === 0) {
    return null;
  }
  const account = accounts[0];
  try {
    const result = await pca.acquireTokenSilent({
      account,
      scopes: ["openid", "profile", "email"],
    });
    return result.idToken ?? null;
  } catch (silentErr) {
    try {
      const result = await pca.acquireTokenPopup({
        account,
        scopes: ["openid", "profile", "email"],
      });
      return result.idToken ?? null;
    } catch (popupErr) {
      const reason =
        (popupErr as { errorCode?: string })?.errorCode ??
        (silentErr as { errorCode?: string })?.errorCode ??
        "unknown";
      emitTokenFailed(reason);
      return null;
    }
  }
}

export async function getAuthorizationHeader(): Promise<Record<string, string>> {
  const token = await acquireIdTokenForApi();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}
