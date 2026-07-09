import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  HomeIcon,
  CompassIcon,
  SearchIcon,
  LibraryIcon,
  SettingsIcon,
  HeartIcon,
  ListMusicIcon,
  PinOffIcon,
  UserPlusIcon,
  UserCogIcon,
  UsersRoundIcon,
  CreditCardIcon,
  LogInIcon,
  LogOutIcon,
  ExternalLinkIcon,
  CheckIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePinned, usePinnedPlaylistsStore } from "@/lib/store/pinned-playlists";
import { openChannelPicker } from "@/lib/store/channel-picker";
import { openSettings } from "@/lib/store/settings-dialog";
import { UpdateBanner } from "@/components/layout/update-banner";
import { fetchAccountInfo } from "@/lib/innertube/account";
import { resetInnertube } from "@/lib/innertube/client";
import { usePremiumStore } from "@/lib/store/premium";
import {
  removeAccount,
  switchAccount,
  useAccounts,
  type AccountSummary,
} from "@/lib/store/accounts";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "Home", icon: HomeIcon },
  { to: "/explore", label: "Explore", icon: CompassIcon },
  { to: "/search", label: "Search", icon: SearchIcon },
  { to: "/library", label: "Library", icon: LibraryIcon },
] as const;

// Liked Songs is the YTM magic playlist — browseId `VLLM` (wraps
// playlistId "LM"). Always present, always first in the playlists
// section, not user-removable.
const LIKED_ID = "VLLM";

const MENU_BTN_CLS = "group-data-[collapsible=icon]:mx-auto";

export function AppSidebar() {
  const { location } = useRouterState();
  const pinned = usePinned();
  const unpin = usePinnedPlaylistsStore((s) => s.unpin);

  const isOn = (to: string) => location.pathname === to;
  const isPlaylistOn = (id: string) =>
    location.pathname === `/playlist/${id}`;

  return (
    <Sidebar
      variant="floating"
      collapsible="icon"
      className="px-2 pb-2 pt-0 duration-300 ease-out [&>[data-slot=sidebar-inner]]:rounded-[10px] [&>[data-slot=sidebar-inner]]:bg-surface [&>[data-slot=sidebar-inner]]:shadow-none"
    >
      <SidebarHeader className="flex-row items-center gap-2 px-4 pt-[18px] pb-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
        {/* Single round logo. In expanded mode it sits at px-4 to line
         *  up with menu icons (which are at group-p-2 + button-p-2 =
         *  16px). In collapsed mode the row centers it like the
         *  centered menu icons below. */}
        <img
          src="/ytubic-icon.svg"
          alt="YTubic"
          className="size-7 shrink-0"
        />
        <span className="text-xl font-semibold leading-none tracking-tight transition-opacity duration-200 group-data-[collapsible=icon]:hidden">
          YTubic
        </span>
      </SidebarHeader>

      <SidebarContent className="gap-0 overflow-x-hidden">
        <SidebarGroup className="py-1">
          <SidebarGroupLabel>Browse</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    asChild
                    isActive={isOn(to)}
                    tooltip={label}
                    className={MENU_BTN_CLS}
                  >
                    <Link to={to}>
                      <Icon />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="py-1">
          <SidebarGroupLabel>Playlists</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isPlaylistOn(LIKED_ID)}
                  tooltip="Liked songs"
                  className={MENU_BTN_CLS}
                >
                  <Link to="/playlist/$id" params={{ id: LIKED_ID }}>
                    <HeartIcon className="fill-rose-500 text-rose-500" />
                    <span>Liked songs</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {pinned.map((p) => (
                <SidebarMenuItem key={p.id}>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <SidebarMenuButton
                        asChild
                        isActive={isPlaylistOn(p.id)}
                        tooltip={p.title}
                        className={MENU_BTN_CLS}
                      >
                        <Link to="/playlist/$id" params={{ id: p.id }}>
                          {p.thumbnailUrl ? (
                            <img
                              src={p.thumbnailUrl}
                              alt=""
                              className="size-4 shrink-0 rounded-sm object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <ListMusicIcon />
                          )}
                          <span>{p.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => unpin(p.id)}>
                        <PinOffIcon />
                        Unpin from sidebar
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <UpdateBanner />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings"
              className={MENU_BTN_CLS}
              onClick={() => openSettings()}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <UserProfile />
      </SidebarFooter>
    </Sidebar>
  );
}

// Where the YT Music web client sends users to manage their Music
// Premium subscription. Kept here (not in a shared constants module)
// because it's the only place that links out to it.
const MANAGE_GOOGLE_URL = "https://myaccount.google.com/";
const MANAGE_SUBSCRIPTION_URL =
  "https://music.youtube.com/paid_memberships";

/**
 * The logged-out footer CTA: a full-width primary (brand red) button.
 * Collapses to a red icon button with a tooltip in icon mode. Runs the
 * same `start_login` flow as "Add another account".
 */
function SidebarSignInButton() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Button
          title="Sign in"
          onClick={() => {
            invoke("start_login").catch((e) =>
              toast.error(`Sign-in failed: ${String(e)}`),
            );
          }}
          className="h-9 w-full gap-2 group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
        >
          <LogInIcon />
          <span className="group-data-[collapsible=icon]:hidden">Sign in</span>
        </Button>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserProfile() {
  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });
  const account = useQuery({
    queryKey: ["account-info"],
    queryFn: () => fetchAccountInfo(),
    enabled: !!loggedIn.data,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const accounts = useAccounts();
  const premiumStatus = usePremiumStore((s) => s.status);

  const allAccounts = accounts.data ?? [];
  const activeAccount = allAccounts.find((a) => a.isActive) ?? allAccounts[0];

  // Auth check still resolving: render nothing to avoid a flash.
  if (loggedIn.isLoading) return null;

  // No live profile: signed out, or `is_logged_in` reports a session (a
  // SAPISID cookie exists) whose `/account_menu` never loads (expired
  // session). With one stored account or none, the primary sign-in
  // button is the way back in; a re-login merges into the existing row
  // via identity dedup, so no duplicate appears. With several stored
  // accounts, collapsing to a sign-in button would strand the user away
  // from the healthy ones (no way to switch or to sign the broken one
  // out), so keep the menu and render it from the stored meta instead.
  if (!account.data) {
    // Give a genuine first paint a moment before falling back.
    if (loggedIn.data === true && account.isLoading) return null;
    if (allAccounts.length < 2) return <SidebarSignInButton />;
  }

  const live = account.data;
  const name =
    live?.name ||
    activeAccount?.channelName ||
    activeAccount?.name ||
    activeAccount?.email ||
    "Account";
  const email = live?.email ?? activeAccount?.email ?? "";
  const photoUrl =
    live?.photoUrl ??
    activeAccount?.channelPhotoUrl ??
    activeAccount?.photoUrl ??
    undefined;
  const initial = (name || email || "?").trim().charAt(0).toUpperCase();
  const isPremium = premiumStatus === "premium";
  const tierLabel = isPremium ? "Premium" : "Free";

  const signOut = async () => {
    if (!activeAccount) {
      // Defensive: should never happen because the trigger only
      // renders when loggedIn is true, but if accounts.data hasn't
      // landed yet we fall back to nuking all auth state.
      try {
        await invoke("clear_cookies");
        resetInnertube();
        toast.success("Signed out");
      } catch (e) {
        toast.error(`Sign out failed: ${String(e)}`);
      }
      return;
    }
    try {
      await removeAccount(activeAccount.id);
      // The Rust `remove_account` either promotes the next account to
      // active (multi-account case) or drops the user to signed-out
      // (last-account case). Either way `accounts-changed` fires and
      // the listener takes care of query invalidation + client reset.
      toast.success("Signed out");
    } catch (e) {
      toast.error(`Sign out failed: ${String(e)}`);
    }
  };

  // Opens an isolated Google sign-in window so the user can pick a
  // *different* identity — the new account is appended to the list
  // rather than replacing the current one. Rust's `start_login`
  // emits `accounts-changed` on success which invalidates the list
  // query for us.
  const addAccount = async () => {
    try {
      await invoke("start_login");
    } catch (e) {
      toast.error(`Sign-in failed: ${String(e)}`);
    }
  };

  const onSwitch = (target: AccountSummary) => async () => {
    if (target.isActive) return;
    try {
      await switchAccount(target.id);
      // `accounts-changed` listener handles all invalidation — no need
      // to do it manually here.
    } catch (e) {
      toast.error(`Switch failed: ${String(e)}`);
    }
  };

  const openExternal = (url: string) => () => {
    openUrl(url).catch((e) => toast.error(String(e)));
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              tooltip={email ? `${name} (${email})` : name}
              className={MENU_BTN_CLS}
            >
              <Avatar className="size-4 shrink-0">
                {photoUrl ? <AvatarImage src={photoUrl} alt={name} /> : null}
                <AvatarFallback className="text-[9px] leading-none">
                  {initial}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{name}</span>
              {/* The tier badge is a claim about the live session; with
                  only stored meta (dead session fallback) it would say
                  "Free" about an account we can't actually see. */}
              {live ? (
                <Badge
                  variant="outline"
                  className={cn(
                    "ms-auto h-4 px-1.5 text-[10px] font-semibold uppercase tracking-wide",
                    "group-data-[collapsible=icon]:hidden",
                    isPremium
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground",
                  )}
                >
                  {tierLabel}
                </Badge>
              ) : null}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="min-w-64"
          >
            {email ? (
              <>
                <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
                  {email}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {allAccounts.length ? (
              <>
                <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Accounts
                </DropdownMenuLabel>
                {allAccounts.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onSelect={onSwitch(a)}
                    // Highlight the active row so the picker reads as
                    // "you are signed in as this one". `data-active`
                    // style mirrors what TanStack Router does on
                    // sidebar links — same visual language across the
                    // app. `focus:bg-accent` from the base item style
                    // still wins on hover, which is what we want.
                    data-active={a.isActive ? "true" : undefined}
                    className={cn(
                      "data-[active=true]:bg-accent/60 data-[active=true]:text-accent-foreground",
                    )}
                  >
                    <Avatar className="size-4 shrink-0">
                      {a.photoUrl ? (
                        <AvatarImage src={a.photoUrl} alt={a.name} />
                      ) : null}
                      <AvatarFallback className="text-[9px] leading-none">
                        {(a.name || a.email || "?")
                          .trim()
                          .charAt(0)
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate">
                        {a.name || a.email || "Unknown account"}
                      </span>
                      {a.email && a.name ? (
                        <span className="truncate text-[10px] text-muted-foreground">
                          {a.email}
                        </span>
                      ) : null}
                    </div>
                    {a.isActive ? (
                      <CheckIcon className="ms-auto text-emerald-500" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem onSelect={() => openChannelPicker()}>
              <UsersRoundIcon />
              Switch channel
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={addAccount}>
              <UserPlusIcon />
              Add another account
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={openExternal(MANAGE_GOOGLE_URL)}>
              <UserCogIcon />
              Manage Google Account
              <ExternalLinkIcon className="ms-auto" />
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={openExternal(MANAGE_SUBSCRIPTION_URL)}
            >
              <CreditCardIcon />
              Manage subscription
              <ExternalLinkIcon className="ms-auto" />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={signOut}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
