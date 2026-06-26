/**
 * Wave W-INS1 · the `allowPopup` seam on `acquireIdTokenForApi`, surfaced as
 * `getAuthorizationHeader` (interactive) vs `getAuthorizationHeaderSilent`
 * (silent). The silent variant must NEVER fall back to an interactive popup —
 * that's what makes it safe for fire-and-forget background callers (telemetry,
 * the error sink). See docs/conventions/authed-raw-fetch.md.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
}));

import {
  registerMsalInstance,
  getAuthorizationHeader,
  getAuthorizationHeaderSilent,
} from "./msalToken";

type PcaShape = {
  getAllAccounts: () => Array<{ username: string }>;
  acquireTokenSilent: (...a: unknown[]) => Promise<{ idToken: string }>;
  acquireTokenPopup: (...a: unknown[]) => Promise<{ idToken: string }>;
};

function makePca(opts: {
  silentThrows?: boolean;
  popupSpy: ReturnType<typeof vi.fn>;
}): PcaShape {
  return {
    getAllAccounts: () => [{ username: "u@example.com" }],
    acquireTokenSilent: vi.fn(async () => {
      if (opts.silentThrows) throw new Error("interaction_required");
      return { idToken: "silent-token" };
    }),
    acquireTokenPopup: opts.popupSpy,
  };
}

afterEach(() => vi.clearAllMocks());

describe("msalToken · silent vs interactive token acquisition", () => {
  test("getAuthorizationHeaderSilent returns {} on silent failure — no popup", async () => {
    const popupSpy = vi.fn(async () => ({ idToken: "popup-token" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerMsalInstance(makePca({ silentThrows: true, popupSpy }) as any);

    const header = await getAuthorizationHeaderSilent();

    expect(header).toEqual({});
    expect(popupSpy).not.toHaveBeenCalled();
  });

  test("getAuthorizationHeader (interactive) DOES fall back to the popup", async () => {
    const popupSpy = vi.fn(async () => ({ idToken: "popup-token" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerMsalInstance(makePca({ silentThrows: true, popupSpy }) as any);

    const header = await getAuthorizationHeader();

    expect(header).toEqual({ Authorization: "Bearer popup-token" });
    expect(popupSpy).toHaveBeenCalledTimes(1);
  });

  test("silent success returns the Bearer header without a popup", async () => {
    const popupSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerMsalInstance(makePca({ silentThrows: false, popupSpy }) as any);

    const header = await getAuthorizationHeaderSilent();

    expect(header).toEqual({ Authorization: "Bearer silent-token" });
    expect(popupSpy).not.toHaveBeenCalled();
  });

  test("signed-out (no accounts) degrades to {} for BOTH helpers — never a popup", async () => {
    // The dominant real-world background-beacon state: a telemetry/error ping
    // firing while the user is signed out must send without a token, never
    // erupt an interactive window. This path returns before the try block, so
    // it must hold for the interactive helper too.
    const popupSpy = vi.fn(async () => ({ idToken: "popup-token" }));
    const silentSpy = vi.fn(async () => ({ idToken: "silent-token" }));
    registerMsalInstance({
      getAllAccounts: () => [],
      acquireTokenSilent: silentSpy,
      acquireTokenPopup: popupSpy,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(await getAuthorizationHeaderSilent()).toEqual({});
    expect(await getAuthorizationHeader()).toEqual({});
    expect(silentSpy).not.toHaveBeenCalled();
    expect(popupSpy).not.toHaveBeenCalled();
  });
});
