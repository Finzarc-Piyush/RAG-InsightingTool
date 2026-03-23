import type { PublicClientApplication } from "@azure/msal-browser";

let pca: PublicClientApplication | null = null;

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
  } catch {
    try {
      const result = await pca.acquireTokenPopup({
        account,
        scopes: ["openid", "profile", "email"],
      });
      return result.idToken ?? null;
    } catch {
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
