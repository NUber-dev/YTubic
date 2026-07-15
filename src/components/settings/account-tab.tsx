import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Loader2Icon,
  LogInIcon,
  UserRoundIcon,
  AlertTriangleIcon,
  CookieIcon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Group, TabPane } from "@/components/settings/primitives";
import { fetchAccountInfo } from "@/lib/innertube/account";

export function AccountTab() {
  return (
    <TabPane tightTop>
      <AccountGroup />
    </TabPane>
  );
}

function AccountGroup() {
  const [signingIn, setSigningIn] = useState(false);
  const [loginReady, setLoginReady] = useState(false);
  const [importing, setImporting] = useState(false);
  const [cookieText, setCookieText] = useState("");

  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });

  useEffect(() => {
    const unlistenSuccess = listen("login-success", () => {
      setSigningIn(false);
      setLoginReady(false);
      toast.success("Signed in");
    });
    const unlistenCancel = listen("login-cancelled", () => {
      setSigningIn(false);
      setLoginReady(false);
    });
    const unlistenFailed = listen<string>("login-failed", (event) => {
      setSigningIn(false);
      setLoginReady(false);
      toast.error(event.payload, { duration: 14_000 });
    });
    const unlistenReady = listen("login-ready", () => {
      setLoginReady(true);
    });

    return () => {
      unlistenSuccess.then((fn) => fn());
      unlistenCancel.then((fn) => fn());
      unlistenFailed.then((fn) => fn());
      unlistenReady.then((fn) => fn());
    };
  }, []);

  const signIn = async () => {
    setSigningIn(true);
    try {
      await invoke("start_login");
    } catch (e) {
      setSigningIn(false);
      toast.error(String(e));
    }
  };

  const confirmLogin = async () => {
    try {
      await invoke("confirm_login");
      toast.message("Finishing sign-in…", {
        description: "Stay on music.youtube.com in the login window.",
      });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const cancelLogin = async () => {
    try {
      await invoke("cancel_login");
    } catch {
      /* window may already be closed */
    }
    setSigningIn(false);
    setLoginReady(false);
  };

  const importCookies = async () => {
    if (!cookieText.trim()) {
      toast.error("Paste Netscape-format cookies first");
      return;
    }
    setImporting(true);
    try {
      await invoke("import_cookies_from_text", { text: cookieText });
      setCookieText("");
      toast.success("Session imported");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setImporting(false);
    }
  };

  const importCookiesFromFile = async () => {
    setImporting(true);
    try {
      await invoke("import_cookies_from_file");
      toast.success("Session imported from file");
    } catch (e) {
      if (!String(e).includes("no file selected")) {
        toast.error(String(e));
      }
    } finally {
      setImporting(false);
    }
  };

  const account = useQuery({
    queryKey: ["account-info"],
    queryFn: () => fetchAccountInfo(),
    enabled: loggedIn.data === true,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Auth check or account profile still loading: avoid flashing.
  if (loggedIn.isLoading || (loggedIn.data === true && account.isLoading)) {
    return null;
  }

  // If successfully logged in, show the signed-in account details in settings!
  if (loggedIn.data === true && account.data) {
    const live = account.data;
    return (
      <Group>
        <div className="flex items-center gap-3 py-2">
          <Avatar className="size-9">
            <AvatarFallback>
              {live.name?.charAt(0).toUpperCase() || "?"}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[15px] font-medium leading-none">
              {live.name}
            </span>
            <span className="text-[13px] text-muted-foreground truncate">
              {live.email}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await invoke("clear_cookies");
                toast.success("Signed out");
              } catch (e) {
                toast.error(String(e));
              }
            }}
          >
            Sign out
          </Button>
        </div>
      </Group>
    );
  }

  return (
    <Group>
      <div className="flex flex-col gap-5 py-2">
        <div className="flex items-center gap-3">
          <Avatar className="size-9">
            <AvatarFallback>
              <UserRoundIcon className="size-[18px]" />
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[15px] font-medium leading-none">
              Not signed in
            </span>
            <span className="text-[13px] text-muted-foreground">
              Sign in to unlock your library, liked songs, and
              Premium-quality streams. Cookies stay on this machine.
            </span>
          </div>
          <Button size="sm" onClick={signIn} disabled={signingIn}>
            {signingIn ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <LogInIcon className="size-4" />
            )}
            Sign in with Google
          </Button>
        </div>

        {loginReady && (
          <div className="flex flex-col gap-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs leading-normal">
            <p>
              In the login window, go to <strong>music.youtube.com</strong> and
              make sure you are signed in, then click Continue. YTubic will save
              your session and close the window automatically.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void confirmLogin()}>
                Continue
              </Button>
              <Button size="sm" variant="outline" onClick={() => void cancelLogin()}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {signingIn && !loginReady && (
          <Button size="sm" variant="outline" className="w-fit" onClick={() => void cancelLogin()}>
            Cancel sign-in
          </Button>
        )}

        <hr className="border-border/50" />

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h4 className="flex items-center gap-2 text-[14px] font-medium leading-none">
              <CookieIcon className="size-4" />
              Import session from browser
            </h4>
            <p className="text-[12px] text-muted-foreground">
              If Google blocks the embedded sign-in window, export cookies from Chrome or Edge where you are already signed in to YouTube Music.
            </p>
          </div>

          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground leading-normal">
            <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              Security warning
            </p>
            <p className="mt-1">
              Pasted cookies are full account credentials. They stay encrypted on this PC only — never share them or paste them into untrusted sites.
            </p>
          </div>

          <div className="text-[12px] text-muted-foreground leading-normal space-y-1.5">
            <p className="font-semibold text-foreground">How to export:</p>
            <ol className="list-decimal space-y-1 ps-4">
              <li>In Chrome or Edge, sign in at <a href="https://music.youtube.com" target="_blank" rel="noreferrer" className="underline hover:text-foreground">music.youtube.com</a></li>
              <li>Use a Netscape cookie exporter extension (e.g. &quot;Get cookies.txt LOCALLY&quot;) for <code>youtube.com</code> and <code>google.com</code></li>
              <li>Paste the file contents below or choose the exported file.</li>
            </ol>
            <p className="text-[11px]">
              Required: cookies for both <code>youtube.com</code> and <code>google.com</code> (need <code>SAPISID</code>, <code>__Secure-1PSID</code>, or <code>LOGIN_INFO</code>).
            </p>
          </div>

          <textarea
            value={cookieText}
            onChange={(e) => setCookieText(e.target.value)}
            placeholder={"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\t..."}
            rows={5}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[11px]"
            spellCheck={false}
          />

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void importCookies()}
              disabled={importing || !cookieText.trim()}
            >
              {importing ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <CookieIcon className="size-4" />
              )}
              Import pasted cookies
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void importCookiesFromFile()}
              disabled={importing}
            >
              {importing ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <UploadIcon className="size-4" />
              )}
              Choose file…
            </Button>
          </div>
        </div>
      </div>
    </Group>
  );
}
