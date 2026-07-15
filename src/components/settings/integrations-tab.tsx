import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Loader2, Unplug } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useSettingsStore } from "@/lib/store/settings";

/**
 * Discord's brand mark. lucide-react ships no brand/social icons, so we
 * inline the official glyph as a filled path that inherits `currentColor`,
 * letting it sit in the same muted icon chip as every other settings row.
 */
function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

/**
 * Last.fm's brand mark (Simple Icons), inlined for the same reason as the
 * Discord glyph above so it inherits `currentColor` in the icon chip.
 */
function LastfmIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M10.584 17.21l-.88-2.392s-1.43 1.594-3.573 1.594c-1.897 0-3.244-1.649-3.244-4.288 0-3.382 1.704-4.591 3.381-4.591 2.42 0 3.189 1.567 3.849 3.574l.88 2.749c.88 2.666 2.529 4.81 7.285 4.81 3.409 0 5.718-1.044 5.718-3.793 0-2.227-1.265-3.381-3.63-3.931l-1.758-.385c-1.21-.275-1.567-.77-1.567-1.595 0-.934.742-1.484 1.952-1.484 1.32 0 2.034.495 2.144 1.677l2.749-.33c-.22-2.474-1.924-3.492-4.729-3.492-2.474 0-4.893.935-4.893 3.932 0 1.87.907 3.051 3.189 3.601l1.87.44c1.402.33 1.869.907 1.869 1.704 0 1.017-.99 1.43-2.86 1.43-2.776 0-3.93-1.457-4.59-3.464l-.907-2.75c-1.155-3.573-2.997-4.893-6.653-4.893C2.144 5.333 0 7.89 0 12.233c0 4.18 2.144 6.434 5.993 6.434 3.106 0 4.591-1.457 4.591-1.457z" />
    </svg>
  );
}

/** Return shape of the `lastfm_begin_auth` command (camelCased by serde). */
type BeginAuth = { token: string; authUrl: string };
/** Return shape of `lastfm_poll_session`: the connected account, or null while
 *  the token is still awaiting the user's approval. */
type LastfmSession = { name: string; key: string };

// The desktop auth flow can't catch a browser callback, so after opening the
// approval page we poll auth.getSession every POLL_INTERVAL_MS until the user
// clicks Allow, giving up after POLL_TIMEOUT_MS.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Last.fm block: connect an account, then scrobble every played track.
 * Connect opens Last.fm's approval page and then auto-detects approval by
 * polling, so there's no manual confirmation step. Signing, scrobble
 * submission, and the offline retry queue live in `src-tauri/src/lastfm.rs`;
 * the play-time timing lives in `lib/lastfm-scrobbler.ts`.
 */
function LastfmSection() {
  const enabled = useSettingsStore((s) => s.lastfmEnabled);
  const setEnabled = useSettingsStore((s) => s.setLastfmEnabled);
  const username = useSettingsStore((s) => s.lastfmUsername);
  const sessionKey = useSettingsStore((s) => s.lastfmSessionKey);
  const setSession = useSettingsStore((s) => s.setLastfmSession);
  const clearSession = useSettingsStore((s) => s.clearLastfmSession);
  const loveSync = useSettingsStore((s) => s.lastfmLoveSync);
  const setLoveSync = useSettingsStore((s) => s.setLastfmLoveSync);
  const avatar = useSettingsStore((s) => s.lastfmAvatar);
  const setAvatar = useSettingsStore((s) => s.setLastfmAvatar);
  const connected = !!sessionKey;

  // null while we ask Rust whether API credentials are baked into this build.
  const [configured, setConfigured] = useState<boolean | null>(null);
  // "awaiting" while the browser approval page is open and we poll for the
  // user clicking Allow. There's no manual confirmation step.
  const [phase, setPhase] = useState<"idle" | "awaiting">("idle");
  // Bumped to invalidate an in-flight poll loop (cancel, unmount, or restart).
  const pollIdRef = useRef(0);

  useEffect(() => {
    void invoke<boolean>("lastfm_is_configured")
      .then(setConfigured)
      .catch(() => setConfigured(false));
  }, []);

  // Stop polling if the tab unmounts (e.g. the Settings dialog closes). The
  // exhaustive-deps rule assumes a ref holds a DOM node that goes stale; here
  // pollIdRef is a plain counter and reading its latest value at cleanup is the
  // whole point: invalidate whichever poll loop is live at that moment.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      pollIdRef.current++;
    };
  }, []);

  // Fetch the Last.fm profile avatar (cosmetic, for the account card).
  const fetchProfile = useCallback(
    async (user: string) => {
      try {
        const info = await invoke<{ image: string }>("lastfm_user_info", {
          user,
        });
        setAvatar(info.image || null);
      } catch {
        /* avatar is cosmetic; ignore failures */
      }
    },
    [setAvatar],
  );

  // Backfill the avatar when already connected (persisted from a previous run,
  // or connected before this feature existed) but none is cached yet.
  useEffect(() => {
    if (configured === true && connected && username && !avatar) {
      void fetchProfile(username);
    }
  }, [configured, connected, username, avatar, fetchProfile]);

  // Poll auth.getSession until the user approves the token in the browser.
  // lastfm_poll_session returns null while pending, the account once approved,
  // and rejects on a real failure (expired token, network).
  const pollForApproval = async (token: string) => {
    const myId = ++pollIdRef.current;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (pollIdRef.current === myId) {
      await sleep(POLL_INTERVAL_MS);
      if (pollIdRef.current !== myId) return; // cancelled or superseded
      let session: LastfmSession | null;
      try {
        session = await invoke<LastfmSession | null>("lastfm_poll_session", {
          token,
        });
      } catch (e) {
        if (pollIdRef.current === myId) {
          setPhase("idle");
          toast.error(`Last.fm sign-in failed: ${String(e)}`);
        }
        return;
      }
      if (pollIdRef.current !== myId) return;
      if (session) {
        setSession(session.name, session.key);
        void fetchProfile(session.name);
        setPhase("idle");
        toast.success(`Connected to Last.fm as ${session.name}`);
        return;
      }
      if (Date.now() >= deadline) {
        setPhase("idle");
        toast.error(
          "Timed out waiting for approval. Click Connect to try again.",
        );
        return;
      }
    }
  };

  const beginConnect = async () => {
    try {
      const { token, authUrl } = await invoke<BeginAuth>("lastfm_begin_auth");
      await openUrl(authUrl);
      setPhase("awaiting");
      void pollForApproval(token);
    } catch (e) {
      toast.error(`Couldn't start Last.fm sign-in: ${String(e)}`);
    }
  };

  const cancelConnect = () => {
    pollIdRef.current++; // invalidate the running poll loop
    setPhase("idle");
  };

  const disconnect = () => {
    pollIdRef.current++;
    clearSession();
    setPhase("idle");
    toast.success("Disconnected from Last.fm");
  };

  const description = (() => {
    if (configured === false)
      return "Last.fm API credentials aren't set in this build.";
    if (phase === "awaiting") return "Waiting for approval in your browser…";
    // The connected account identity lives in the account card below, so this
    // stays a description of the feature itself in every state.
    return "Scrobble every track you play to your Last.fm profile.";
  })();

  let control: ReactNode = null;
  if (configured === true) {
    if (connected) {
      control = (
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Last.fm scrobbling"
        />
      );
    } else if (phase === "awaiting") {
      control = (
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <Button variant="ghost" size="sm" onClick={cancelConnect}>
            Cancel
          </Button>
        </div>
      );
    } else {
      control = (
        <Button variant="outline" size="sm" onClick={() => void beginConnect()}>
          Connect
        </Button>
      );
    }
  }

  return (
    <div className="flex flex-col">
      <SettingRow
        icon={LastfmIcon}
        title="Last.fm Scrobbling"
        description={description}
        control={control}
      />
      {configured === true && connected ? (
        <div className="flex flex-col gap-4 pb-4 pl-12">
          {/* Connected-account card: avatar, username, profile link, and the
              Disconnect action, matching the surface-panel language. The
              parent's pl-12 lines the whole block up with the row titles
              above (past the icon-chip column). */}
          <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-surface px-3 py-2.5">
            {avatar ? (
              <img
                src={avatar}
                alt=""
                className="size-10 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                <LastfmIcon className="size-5 text-muted-foreground" />
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold leading-tight">
                {username ?? "Last.fm"}
              </span>
              {username ? (
                <span className="truncate text-xs text-muted-foreground">
                  last.fm/user/{username}
                </span>
              ) : null}
            </div>
            <Button variant="outline" size="sm" onClick={disconnect}>
              <Unplug className="size-3.5" />
              Disconnect
            </Button>
          </div>
          {/* Sync liked songs: a sub-setting of the connection (no icon chip
              of its own); inherits the parent's pl-12. */}
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[15px] font-medium leading-none">
                Sync liked songs
              </span>
              <span className="text-[13px] text-muted-foreground">
                Also mark tracks you like in YouTube Music as Loved on Last.fm.
              </span>
            </div>
            <Switch
              checked={loveSync}
              onCheckedChange={setLoveSync}
              aria-label="Sync liked songs to Last.fm"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Integrations tab: third-party services YTubic can broadcast to.
 * Discord Rich Presence and Last.fm scrobbling both react to the same
 * now-playing state, mirrored out over their own backends.
 */
export function IntegrationsTab() {
  const discordRichPresence = useSettingsStore((s) => s.discordRichPresence);
  const setDiscordRichPresence = useSettingsStore(
    (s) => s.setDiscordRichPresence,
  );

  return (
    <TabPane tightTop>
      <Group>
        <SettingRow
          icon={DiscordIcon}
          title="Discord Rich Presence"
          description="Show the current track on your Discord profile while it plays."
          control={
            <Switch
              checked={discordRichPresence}
              onCheckedChange={setDiscordRichPresence}
              aria-label="Discord Rich Presence"
            />
          }
        />
      </Group>
      <LastfmSection />
    </TabPane>
  );
}
