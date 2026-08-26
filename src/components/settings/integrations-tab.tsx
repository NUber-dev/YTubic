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
import { IconLoader2 } from "@tabler/icons-react";
import { IconPlugConnectedXFilled } from "@/components/shared/filled-icons";

import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useSettingsStore } from "@/lib/store/settings";
import { DiscordIcon, LastfmIcon } from "@/components/shared/brand-icons";

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
          <IconLoader2 className="size-4 animate-spin text-t6" />
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
          <div className="flex items-center gap-3 rounded-xl border border-w075 bg-w028 px-3 py-2.5">
            {avatar ? (
              <img
                src={avatar}
                alt=""
                className="size-10 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div className="grid size-10 shrink-0 place-items-center rounded-full border border-w070 bg-w050">
                <LastfmIcon className="size-5 text-t5" />
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold leading-tight text-t2">
                {username ?? "Last.fm"}
              </span>
              {username ? (
                <span className="truncate text-xs text-t7">
                  last.fm/user/{username}
                </span>
              ) : null}
            </div>
            <Button variant="outline" size="sm" onClick={disconnect}>
              <IconPlugConnectedXFilled className="size-3.5" />
              Disconnect
            </Button>
          </div>
          {/* Sync liked songs: a sub-setting of the connection (no icon chip
              of its own); inherits the parent's pl-12. */}
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-sm font-semibold leading-none text-t2">
                Sync liked songs
              </span>
              <span className="text-[12.5px] leading-snug text-t7">
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
    <TabPane>
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
