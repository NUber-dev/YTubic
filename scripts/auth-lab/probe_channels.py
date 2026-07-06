#!/usr/bin/env python3
"""Probe YouTube channel-switcher endpoints."""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from auth_lab import (  # noqa: E402
    TestConfig,
    collect_channels,
    cookie_header,
    fetch_client_version,
    filter_rows,
    innertube_post,
    load_ytubic_netscape,
    parse_netscape,
    pick_sapisid,
    sapisid_hash,
)

WEB_VERSION = "2.20250312.01.00"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def post_custom(
    origin: str,
    client_name: str,
    client_num: int,
    endpoint: str,
    body: dict,
    cookie: str,
    sap: str | None,
    ver: str,
) -> tuple[int, object]:
    user = {"lockedSafetyMode": False}
    cv = ver if client_name == "WEB_REMIX" else WEB_VERSION
    client: dict = {
        "clientName": client_name,
        "clientVersion": cv,
        "hl": "en",
        "gl": "US",
        "platform": "DESKTOP",
        "userAgent": f"{UA},gzip(gfe)",
    }
    if client_name == "WEB_REMIX":
        client["originalUrl"] = f"{origin}/"
    headers = {
        "Content-Type": "application/json",
        "User-Agent": UA,
        "X-YouTube-Client-Name": str(client_num),
        "X-YouTube-Client-Version": cv,
        "Origin": origin,
        "Referer": f"{origin}/",
        "Cookie": cookie,
        "X-Goog-AuthUser": "0",
    }
    if sap:
        headers["Authorization"] = sapisid_hash(sap, origin)
    payload = {
        "context": {"client": client, "user": user, "request": {"useSsl": True}},
        **body,
    }
    url = f"{origin}/youtubei/v1/{endpoint}?prettyPrint=false"
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:400]


def get_switcher(origin: str, cookie: str, sap: str | None) -> tuple[int, str]:
    headers = {"User-Agent": UA, "Cookie": cookie}
    if sap:
        headers["Authorization"] = sapisid_hash(sap, origin)
    req = urllib.request.Request(f"{origin}/getAccountSwitcherEndpoint", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:600]


def main() -> None:
    plain, _ = load_ytubic_netscape()
    rows = parse_netscape(plain)
    yt = filter_rows(rows, "youtube")
    cookie = cookie_header(yt)
    sap = pick_sapisid(rows, "flat-3p-then-s")
    auth = sapisid_hash(sap) if sap else None
    ver = fetch_client_version()
    cfg = TestConfig(label="t", cookie_mode="youtube")

    _, menu = innertube_post(cfg, cookie, auth, "account/account_menu", {}, ver)
    print("account_menu channels:", collect_channels(menu))
    print(
        "account_menu flags:",
        {
            k: k in json.dumps(menu)
            for k in (
                "selectActiveIdentityEndpoint",
                "accountItem",
                "channelHandle",
                "accountSectionListRenderer",
            )
        },
    )

    bodies = [
        (
            "CHANNEL_SWITCHER FULL",
            {
                "requestType": "ACCOUNTS_LIST_REQUEST_TYPE_CHANNEL_SWITCHER",
                "callCircumstance": "SWITCHING_USERS_FULL",
            },
        ),
        (
            "CHANNEL_SWITCHER",
            {
                "requestType": "ACCOUNTS_LIST_REQUEST_TYPE_CHANNEL_SWITCHER",
                "callCircumstance": "SWITCHING_USERS",
            },
        ),
        ("empty", {}),
    ]
    for label, body in bodies:
        for host, cname, cnum in (
            ("https://www.youtube.com", "WEB", 1),
            ("https://music.youtube.com", "WEB_REMIX", 67),
        ):
            st, resp = post_custom(host, cname, cnum, "account/accounts_list", body, cookie, sap, ver)
            ch = collect_channels(resp) if isinstance(resp, dict) else []
            keys = list(resp.keys()) if isinstance(resp, dict) else ["err"]
            print(f"{host} {cname} {label}: st={st} ch={len(ch)} keys={keys}")
            if ch:
                for c in ch:
                    print(" ", c)

    for host in ("https://www.youtube.com", "https://music.youtube.com"):
        st, text = get_switcher(host, cookie, sap)
        print(f"GET switcher {host}: st={st} len={len(text)}")
        if text.startswith(")]}'"):
            data = json.loads(text[4:])
            ch = collect_channels(data)
            print("  channels:", ch)
            out = Path(__file__).parent / f"switcher_{host.split('//')[1].replace('.', '_')}.json"
            out.write_text(json.dumps(data, indent=2), encoding="utf-8")
            print("  wrote", out)


if __name__ == "__main__":
    main()
