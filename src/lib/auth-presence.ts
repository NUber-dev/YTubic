/** What the sidebar's account slot should render. */
export type AccountSlot = "wait" | "sign-in" | "profile";

export type AccountSlotInput = {
  /** `is_logged_in`; `undefined` until the query resolves. */
  loggedIn: boolean | undefined;
  /** The stored-account list hasn't landed yet. */
  accountsPending: boolean;
  /** How many accounts are stored on disk. */
  storedCount: number;
  /** `/account_menu` returned a live identity. */
  hasLiveAccount: boolean;
  /** `/account_menu` still in flight, retries included. */
  accountLoading: boolean;
  /** `/account_menu` gave up after exhausting its retries. */
  accountErrored: boolean;
};

/**
 * Decide what the sidebar shows for the signed-in user.
 *
 * This is the call that produced the "app opens not logged in after a
 * shutdown / lock / standby" reports, so it lives here as a pure
 * function with tests rather than as conditions inside the component.
 *
 * The rule it encodes: **only render the sign-in button when something
 * authoritative says the user is signed out.** Authoritative means one
 * of "there is no cookie jar", "nothing is stored", or "Google answered
 * and the answer was anonymous". A request that never got an answer,
 * because it is still retrying or because it threw when the NIC wasn't
 * up yet after a cold boot or a resume, carries no information about
 * the session and must not be allowed to look like a logout. In that
 * case we fall back to the stored account meta, which is what the
 * multi-account path has always done.
 *
 * `wait` also covers the window where `PersistQueryClientProvider` is
 * rehydrating the query cache: every query then reports
 * `isLoading: false` with `data: undefined`, so keying off `isLoading`
 * alone painted a sign-in button before the session was looked at once.
 */
export function accountSlot(s: AccountSlotInput): AccountSlot {
  if (s.loggedIn === undefined) return "wait";
  // `storedCount` is what the fallback renders from, so "not loaded
  // yet" must not be mistaken for "there are none".
  if (s.accountsPending) return "wait";
  if (s.hasLiveAccount) return "profile";
  if (s.storedCount === 0) return "sign-in";
  // Google answered "anonymous". With one stored account the sign-in
  // button is the way back in (a re-login merges into the existing row
  // via identity dedup). With several, collapsing to it would strand
  // the user away from the healthy ones, with no way to switch or to
  // sign the broken one out.
  const answered = !s.accountLoading && !s.accountErrored;
  if (answered && s.storedCount < 2) return "sign-in";
  return "profile";
}
