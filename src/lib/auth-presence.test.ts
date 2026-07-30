import { describe, expect, it } from "vitest";
import { accountSlot, type AccountSlotInput } from "./auth-presence";

/** A healthy signed-in session; each test overrides what it cares about. */
const healthy: AccountSlotInput = {
  loggedIn: true,
  accountsPending: false,
  storedCount: 1,
  hasLiveAccount: true,
  accountLoading: false,
  accountErrored: false,
};

const slot = (over: Partial<AccountSlotInput>) =>
  accountSlot({ ...healthy, ...over });

describe("accountSlot", () => {
  it("renders the profile for a live session", () => {
    expect(slot({})).toBe("profile");
  });

  it("waits while the login check is unresolved", () => {
    // The PersistQueryClientProvider restore window: isLoading is false
    // but data is still undefined.
    expect(slot({ loggedIn: undefined, hasLiveAccount: false })).toBe("wait");
  });

  it("waits while the stored-account list is still loading", () => {
    expect(
      slot({ accountsPending: true, storedCount: 0, hasLiveAccount: false }),
    ).toBe("wait");
  });

  it("offers sign-in when nothing is stored and nobody is signed in", () => {
    expect(
      slot({ loggedIn: false, storedCount: 0, hasLiveAccount: false }),
    ).toBe("sign-in");
  });

  it("offers sign-in when Google answers anonymous for the only account", () => {
    expect(slot({ hasLiveAccount: false })).toBe("sign-in");
  });

  it("keeps the menu when Google answers anonymous but several accounts are stored", () => {
    expect(slot({ hasLiveAccount: false, storedCount: 3 })).toBe("profile");
  });

  // The regression this whole fix exists for: a cold boot or a resume
  // from standby where /account_menu threw because the network wasn't
  // usable yet. A failure is not a logout.
  it("does NOT offer sign-in while the account check is still retrying", () => {
    expect(slot({ hasLiveAccount: false, accountLoading: true })).toBe(
      "profile",
    );
  });

  it("does NOT offer sign-in when the account check errored out", () => {
    expect(slot({ hasLiveAccount: false, accountErrored: true })).toBe(
      "profile",
    );
  });

  it("still offers sign-in on an errored check when nothing is stored", () => {
    // Nothing to fall back to, so the button is the only honest render.
    expect(
      slot({ hasLiveAccount: false, accountErrored: true, storedCount: 0 }),
    ).toBe("sign-in");
  });
});
