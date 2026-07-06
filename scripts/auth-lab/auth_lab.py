#!/usr/bin/env python3
"""
YTubic InnerTube auth lab — test cookie / header combinations without rebuilding the app.

Usage:
  python auth_lab.py ytubic              # load cookies from YTubic AppData
  python auth_lab.py file cookies.txt    # load Netscape export
  python auth_lab.py file cookies.txt --brand 123456789012345678901
  python auth_lab.py ytubic --json out.json
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ORIGIN = "https://music.youtube.com"
DEFAULT_CLIENT_VERSION = "1.20260510.02.00"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
DPAPI_ENTROPY = b"ytm-native/cookies.enc v1"
YTBIC_APPDATA = Path.home() / "AppData" / "Roaming" / "com.github.ivasy.ytubic"


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def dpapi_decrypt(data: bytes) -> bytes:
    CryptUnprotectData = ctypes.windll.crypt32.CryptUnprotectData
    LocalFree = ctypes.windll.kernel32.LocalFree
    in_blob = DATA_BLOB(
        len(data),
        ctypes.cast(ctypes.create_string_buffer(data), ctypes.POINTER(ctypes.c_char)),
    )
    ent_blob = DATA_BLOB(
        len(DPAPI_ENTROPY),
        ctypes.cast(
            ctypes.create_string_buffer(DPAPI_ENTROPY), ctypes.POINTER(ctypes.c_char)
        ),
    )
    out_blob = DATA_BLOB()
    if not CryptUnprotectData(
        ctypes.byref(in_blob), None, ctypes.byref(ent_blob), None, None, 0, ctypes.byref(out_blob)
    ):
        raise OSError("CryptUnprotectData failed — run as the same Windows user as YTubic")
    buf = ctypes.string_at(out_blob.pbData, out_blob.cbData)
    LocalFree(out_blob.pbData)
    return buf


@dataclass
class CookieRow:
    domain: str
    name: str
    value: str


def parse_netscape(text: str) -> list[CookieRow]:
    rows: list[CookieRow] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            if line.startswith("#HttpOnly_"):
                line = line[len("#HttpOnly_") :]
            else:
                continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        rows.append(CookieRow(domain=parts[0], name=parts[5], value=parts[6]))
    if not rows:
        raise ValueError("no cookies parsed — need Netscape format (tab-separated)")
    return rows


def load_ytubic_netscape() -> tuple[str, Path]:
    index_path = YTBIC_APPDATA / "accounts.json"
    if not index_path.exists():
        raise FileNotFoundError(f"no accounts.json at {index_path}")
    index = json.loads(index_path.read_text(encoding="utf-8"))
    active = index.get("active")
    if not active:
        raise FileNotFoundError("YTubic has no active account — sign in or import first")
    enc = YTBIC_APPDATA / "accounts" / active / "cookies.enc"
    if not enc.exists():
        raise FileNotFoundError(f"missing {enc}")
    plain = dpapi_decrypt(enc.read_bytes()).decode("utf-8")
    return plain, enc


def domain_bare(domain: str) -> str:
    return domain.lstrip(".")


def filter_rows(rows: list[CookieRow], mode: str) -> list[CookieRow]:
    out: list[CookieRow] = []
    seen: set[tuple[str, str]] = set()
    for r in rows:
        bare = domain_bare(r.domain)
        if mode == "youtube" and not bare.endswith("youtube.com"):
            continue
        if mode == "google" and not bare.endswith("google.com"):
            continue
        if mode == "all" and not (
            bare.endswith("youtube.com") or bare.endswith("google.com")
        ):
            continue
        key = (r.name, bare)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def cookie_header(rows: list[CookieRow]) -> str:
    return "; ".join(f"{r.name}={r.value}" for r in rows)


def pick_sapisid(rows: list[CookieRow], strategy: str) -> str | None:
    yt_3p = yt_s = g_3p = g_s = None
    for r in rows:
        bare = domain_bare(r.domain)
        if r.name == "__Secure-3PAPISID" and bare.endswith("youtube.com"):
            yt_3p = r.value
        elif r.name == "SAPISID" and bare.endswith("youtube.com"):
            yt_s = r.value
        elif r.name == "__Secure-3PAPISID" and bare.endswith("google.com"):
            g_3p = r.value
        elif r.name == "SAPISID" and bare.endswith("google.com"):
            g_s = r.value
    table = {
        "yt-3papisid": yt_3p,
        "yt-sapisid": yt_s,
        "google-3papisid": g_3p,
        "google-sapisid": g_s,
        "flat-3p-then-s": yt_3p or g_3p or yt_s or g_s,
        "google-sapisid-first": g_s or yt_s or g_3p or yt_3p,
    }
    return table.get(strategy)


def sapisid_hash(sapisid: str, origin: str = ORIGIN) -> str:
    ts = int(time.time())
    digest = hashlib.sha1(f"{ts} {sapisid} {origin}".encode()).hexdigest()
    return f"SAPISIDHASH {ts}_{digest}"


def fetch_client_version() -> str:
    try:
        html = urllib.request.urlopen(ORIGIN, timeout=15).read().decode("utf-8", "replace")
        for pat in (
            r'INNERTUBE_CLIENT_VERSION":"([^"]+)"',
            r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"',
        ):
            m = re.search(pat, html)
            if m:
                return m.group(1)
    except Exception:
        pass
    return DEFAULT_CLIENT_VERSION


@dataclass
class TestConfig:
    label: str
    cookie_mode: str = "all"
    sapisid_strategy: str = "flat-3p-then-s"
    authuser: str = "0"
    brand_id: str | None = None
    client_version: str | None = None
    visitor_data: str | None = None
    skip_auth: bool = False


@dataclass
class TestResult:
    config: TestConfig
    account_menu_status: int
    account_signed_in: bool
    account_name: str | None
    browse_playlists_status: int
    browse_has_library: bool
    browse_error_snippet: str | None
    accounts_list_status: int | None = None
    channel_count: int = 0
    channels: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None


def innertube_post(
    cfg: TestConfig,
    cookie: str,
    authorization: str | None,
    endpoint: str,
    body: dict[str, Any],
    client_version: str,
) -> tuple[int, Any]:
    user: dict[str, Any] = {"lockedSafetyMode": False}
    if cfg.brand_id:
        user["onBehalfOfUser"] = cfg.brand_id
    client: dict[str, Any] = {
        "clientName": "WEB_REMIX",
        "clientVersion": client_version,
        "hl": "en",
        "gl": "US",
        "platform": "DESKTOP",
        "userAgent": f"{USER_AGENT},gzip(gfe)",
        "originalUrl": f"{ORIGIN}/",
    }
    if cfg.visitor_data:
        client["visitorData"] = cfg.visitor_data
    headers = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-YouTube-Client-Name": "67",
        "X-YouTube-Client-Version": client_version,
        "Origin": ORIGIN,
        "Referer": f"{ORIGIN}/",
        "X-Origin": ORIGIN,
        "X-Goog-AuthUser": cfg.authuser,
        "Cookie": cookie,
    }
    if authorization:
        headers["Authorization"] = authorization
    if cfg.visitor_data:
        headers["X-Goog-Visitor-Id"] = cfg.visitor_data
    payload = {"context": {"client": client, "user": user, "request": {"useSsl": True}}, **body}
    req = urllib.request.Request(
        f"{ORIGIN}/youtubei/v1/{endpoint}?prettyPrint=false",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:600]


def parse_account_menu(payload: dict) -> tuple[bool, str | None]:
    header = (
        payload.get("actions", [{}])[0]
        .get("openPopupAction", {})
        .get("popup", {})
        .get("multiPageMenuRenderer", {})
        .get("header", {})
        .get("activeAccountHeaderRenderer")
    )
    if not header:
        return False, None
    name = header.get("accountName", {})
    text = name.get("simpleText")
    if not text and isinstance(name.get("runs"), list):
        text = "".join(r.get("text", "") for r in name["runs"])
    return True, text


def parse_browse_library(payload: dict | str) -> tuple[bool, str | None]:
    if isinstance(payload, str):
        return False, payload
    blob = json.dumps(payload).lower()
    if "sign in" in blob and "liked" not in blob:
        return False, "sign-in prompt in response"
    tabs = (
        payload.get("contents", {})
        .get("singleColumnBrowseResultsRenderer", {})
        .get("tabs", [])
    )
    if tabs:
        sections = (
            tabs[0]
            .get("tabRenderer", {})
            .get("content", {})
            .get("sectionListRenderer", {})
            .get("contents", [])
        )
        if sections:
            return True, None
    return False, "no library sections in response"


def collect_channels(payload: dict | str) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    channels: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if "accountName" in node:
                name_runs = node.get("accountName", {})
                name = name_runs.get("simpleText")
                if not name and isinstance(name_runs.get("runs"), list):
                    name = "".join(r.get("text", "") for r in name_runs["runs"])
                handle_runs = node.get("channelHandle", {})
                handle = handle_runs.get("simpleText")
                if not handle and isinstance(handle_runs.get("runs"), list):
                    handle = "".join(r.get("text", "") for r in handle_runs["runs"])
                brand_id = extract_brand_id(node)
                if name:
                    channels.append(
                        {
                            "name": name,
                            "handle": handle,
                            "brandId": brand_id,
                            "isSelected": bool(node.get("isSelected")),
                        }
                    )
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    dedup: list[dict[str, Any]] = []
    seen: set[str] = set()
    for ch in channels:
        key = f"{ch.get('brandId') or 'primary'}:{ch['name']}"
        if key in seen:
            continue
        seen.add(key)
        dedup.append(ch)
    return dedup


def extract_brand_id(node: dict) -> str | None:
    endpoint = node.get("serviceEndpoint") or node.get("endpoint")
    if not isinstance(endpoint, dict):
        return None
    select = endpoint.get("selectActiveIdentityEndpoint")
    if not isinstance(select, dict):
        return None
    tokens = select.get("supportedTokens") or []
    for token in tokens:
        if not isinstance(token, dict):
            continue
        page = token.get("pageIdToken") or {}
        pid = page.get("pageId")
        if isinstance(pid, str) and re.fullmatch(r"\d{21}", pid):
            return pid
    return None


def run_test(rows: list[CookieRow], cfg: TestConfig, client_version: str) -> TestResult:
    filtered = filter_rows(rows, cfg.cookie_mode)
    cookie = cookie_header(filtered)
    auth = None
    if not cfg.skip_auth:
        sap = pick_sapisid(rows, cfg.sapisid_strategy)
        if not sap:
            return TestResult(
                config=cfg,
                account_menu_status=0,
                account_signed_in=False,
                account_name=None,
                browse_playlists_status=0,
                browse_has_library=False,
                browse_error_snippet=None,
                error=f"no SAPISID for strategy {cfg.sapisid_strategy}",
            )
        auth = sapisid_hash(sap)

    am_status, am_body = innertube_post(cfg, cookie, auth, "account/account_menu", {}, client_version)
    signed_in, name = (False, None)
    if isinstance(am_body, dict):
        signed_in, name = parse_account_menu(am_body)

    br_status, br_body = innertube_post(
        cfg, cookie, auth, "browse", {"browseId": "FEmusic_liked_playlists"}, client_version
    )
    has_lib, br_err = parse_browse_library(br_body)

    al_status: int | None = None
    channels: list[dict[str, Any]] = []
    if signed_in or cfg.brand_id:
        al_status, al_body = innertube_post(
            cfg,
            cookie,
            auth,
            "account/accounts_list",
            {},
            client_version,
        )
        if isinstance(al_body, dict):
            channels = collect_channels(al_body)

    return TestResult(
        config=cfg,
        account_menu_status=am_status,
        account_signed_in=signed_in,
        account_name=name,
        browse_playlists_status=br_status,
        browse_has_library=has_lib,
        browse_error_snippet=br_err if not has_lib else None,
        accounts_list_status=al_status,
        channel_count=len(channels),
        channels=channels,
    )


def build_matrix(brand_id: str | None, live_version: str) -> list[TestConfig]:
    configs: list[TestConfig] = []
    for cookie_mode in ("all", "youtube", "google"):
        for sap in ("flat-3p-then-s", "google-sapisid-first", "yt-3papisid", "google-sapisid"):
            configs.append(
                TestConfig(
                    label=f"cookies={cookie_mode} hash={sap}",
                    cookie_mode=cookie_mode,
                    sapisid_strategy=sap,
                )
            )
    for authuser in ("0", "1", "2"):
        configs.append(
            TestConfig(
                label=f"authuser={authuser}",
                authuser=authuser,
            )
        )
    configs.append(TestConfig(label="live-client-version", client_version=live_version))
    configs.append(TestConfig(label="default-client-version", client_version=DEFAULT_CLIENT_VERSION))
    if brand_id:
        configs.append(TestConfig(label=f"brand={brand_id}", brand_id=brand_id))
    return configs


def print_report(results: list[TestResult], source: str) -> None:
    print(f"\n{'=' * 72}")
    print(f"YTubic Auth Lab — source: {source}")
    print(f"{'=' * 72}\n")

    winners = [r for r in results if r.account_signed_in and r.browse_has_library]
    partial = [r for r in results if r.account_signed_in and not r.browse_has_library]
    anon = [r for r in results if not r.account_signed_in and not r.error]

    if winners:
        print("WORKING (signed in + library):\n")
        for r in winners:
            ch = f", channels={r.channel_count}" if r.channel_count else ""
            print(f"  ✓ {r.config.label}")
            print(f"    account={r.account_name!r}  browse HTTP {r.browse_playlists_status}{ch}")
            if r.channels:
                for c in r.channels:
                    mark = " *" if c.get("isSelected") else ""
                    bid = c.get("brandId") or "primary"
                    print(f"      - {c['name']} ({c.get('handle') or bid}){mark}")
        print()
    else:
        print("No configuration fully worked (account + library).\n")

    if partial:
        print("PARTIAL (signed in, library failed):\n")
        for r in partial[:8]:
            print(f"  ~ {r.config.label} — browse HTTP {r.browse_playlists_status}: {r.browse_error_snippet}")
        print()

    if anon:
        print(f"Anonymous / failed account_menu: {len(anon)} configs\n")

    errors = [r for r in results if r.error]
    if errors:
        print("ERRORS:\n")
        for r in errors:
            print(f"  ! {r.config.label}: {r.error}")
        print()

    print("All results:")
    for r in results:
        status = "OK" if r.account_signed_in and r.browse_has_library else (
            "PARTIAL" if r.account_signed_in else "FAIL"
        )
        if r.error:
            status = "ERROR"
        print(
            f"  [{status:7}] {r.config.label:40} "
            f"menu={r.account_menu_status} account={'yes' if r.account_signed_in else 'no':3} "
            f"browse={r.browse_playlists_status} lib={'yes' if r.browse_has_library else 'no'}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Test YT Music InnerTube auth strategies")
    parser.add_argument("source", choices=["ytubic", "file"], help="cookie source")
    parser.add_argument("path", nargs="?", help="path to Netscape cookies.txt when source=file")
    parser.add_argument("--brand", help="21-digit brand id to test onBehalfOfUser")
    parser.add_argument("--json", dest="json_out", help="write full results JSON here")
    parser.add_argument("--quick", action="store_true", help="run fewer combinations")
    args = parser.parse_args()

    if args.source == "ytubic":
        netscape, path = load_ytubic_netscape()
        source_label = str(path)
    else:
        if not args.path:
            print("file source requires path to cookies.txt", file=sys.stderr)
            return 2
        p = Path(args.path)
        netscape = p.read_text(encoding="utf-8")
        source_label = str(p)

    rows = parse_netscape(netscape)
    live_ver = fetch_client_version()
    print(f"Loaded {len(rows)} cookie rows from {source_label}")
    print(f"Live YTM client version: {live_ver}")

    if args.quick:
        configs = [
            TestConfig("quick-all-flat", "all", "flat-3p-then-s"),
            TestConfig("quick-all-google-sap", "all", "google-sapisid-first"),
            TestConfig("quick-youtube-only", "youtube", "yt-3papisid"),
        ]
        if args.brand:
            configs.append(TestConfig(f"quick-brand", brand_id=args.brand))
    else:
        configs = build_matrix(args.brand, live_ver)

    results: list[TestResult] = []
    for cfg in configs:
        ver = cfg.client_version or live_ver
        results.append(run_test(rows, cfg, ver))
        time.sleep(0.15)

    print_report(results, source_label)

    if args.json_out:
        out = []
        for r in results:
            out.append(
                {
                    "label": r.config.label,
                    "account_signed_in": r.account_signed_in,
                    "account_name": r.account_name,
                    "browse_has_library": r.browse_has_library,
                    "browse_status": r.browse_playlists_status,
                    "channels": r.channels,
                    "error": r.error,
                }
            )
        Path(args.json_out).write_text(json.dumps(out, indent=2), encoding="utf-8")
        print(f"Wrote {args.json_out}")

    return 0 if any(r.account_signed_in and r.browse_has_library for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
