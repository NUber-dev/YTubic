import ctypes
import ctypes.wintypes as wt
import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def decrypt(data: bytes, entropy: bytes) -> bytes:
    CryptUnprotectData = ctypes.windll.crypt32.CryptUnprotectData
    LocalFree = ctypes.windll.kernel32.LocalFree
    in_blob = DATA_BLOB(
        len(data),
        ctypes.cast(ctypes.create_string_buffer(data), ctypes.POINTER(ctypes.c_char)),
    )
    ent_blob = DATA_BLOB(
        len(entropy),
        ctypes.cast(ctypes.create_string_buffer(entropy), ctypes.POINTER(ctypes.c_char)),
    )
    out_blob = DATA_BLOB()
    if not CryptUnprotectData(
        ctypes.byref(in_blob), None, ctypes.byref(ent_blob), None, None, 0, ctypes.byref(out_blob)
    ):
        raise OSError("CryptUnprotectData failed")
    buf = ctypes.string_at(out_blob.pbData, out_blob.cbData)
    LocalFree(out_blob.pbData)
    return buf


def build_cookie_header(plain: str, youtube_only: bool = False) -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for line in plain.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) < 7:
            continue
        dom = fields[0].lstrip(".")
        if youtube_only:
            if not dom.endswith("youtube.com"):
                continue
        elif not (dom.endswith("youtube.com") or dom.endswith("google.com")):
            continue
        key = f"{fields[5]}@{dom}"
        if key in seen:
            continue
        seen.add(key)
        parts.append(f"{fields[5]}={fields[6]}")
    return "; ".join(parts)


def sapisid_hash(cookie: str, origin: str) -> str:
    sapisid = None
    for part in cookie.split("; "):
        if part.startswith("__Secure-3PAPISID="):
            sapisid = part.split("=", 1)[1]
            break
        if part.startswith("SAPISID="):
            sapisid = part.split("=", 1)[1]
    ts = int(time.time())
    digest = hashlib.sha1(f"{ts} {sapisid} {origin}".encode()).hexdigest()
    return f"SAPISIDHASH {ts}_{digest}"


def post(cookie: str, endpoint: str, body: dict, brand_id: str | None = None) -> tuple[int, dict | str]:
    origin = "https://music.youtube.com"
    ver = "1.20260510.02.00"
    user: dict = {"lockedSafetyMode": False}
    if brand_id:
        user["onBehalfOfUser"] = brand_id
    ctx = {
        "client": {
            "clientName": "WEB_REMIX",
            "clientVersion": ver,
            "hl": "en",
            "gl": "US",
            "platform": "DESKTOP",
            "userAgent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36,gzip(gfe)"
            ),
            "originalUrl": "https://music.youtube.com/",
        },
        "user": user,
        "request": {"useSsl": True},
    }
    headers = {
        "Content-Type": "application/json",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "X-YouTube-Client-Name": "67",
        "X-YouTube-Client-Version": ver,
        "Origin": origin,
        "Referer": origin + "/",
        "X-Origin": origin,
        "X-Goog-AuthUser": "0",
        "Cookie": cookie,
        "Authorization": sapisid_hash(cookie, origin),
    }
    data = json.dumps({"context": ctx, **body}).encode()
    req = urllib.request.Request(
        f"https://music.youtube.com/youtubei/v1/{endpoint}?prettyPrint=false",
        data=data,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:500]


def main() -> None:
    import sys

    if len(sys.argv) < 2:
        appdata = Path.home() / "AppData" / "Roaming" / "com.github.ivasy.ytubic"
        index_path = appdata / "accounts.json"
        if not index_path.exists():
            print("Usage: python probe_innertube.py <cookies.enc path>", file=sys.stderr)
            print("Or sign in to YTubic first (needs accounts.json in AppData).", file=sys.stderr)
            sys.exit(1)
        index = json.loads(index_path.read_text(encoding="utf-8"))
        active = index.get("active")
        if not active:
            print("No active YTubic account.", file=sys.stderr)
            sys.exit(1)
        path = appdata / "accounts" / active / "cookies.enc"
    else:
        path = Path(sys.argv[1])
    plain = decrypt(path.read_bytes(), b"ytm-native/cookies.enc v1").decode("utf-8")
    for label, yt_only in [("all google+youtube", False), ("youtube only", True)]:
        cookie = build_cookie_header(plain, youtube_only=yt_only)
        print(f"\n=== {label} ===")
        print(f"Cookie header length: {len(cookie)}")
        print(f"Has LOGIN_INFO: {'LOGIN_INFO' in cookie}")
        print(f"Has __Secure-1PSID: {'__Secure-1PSID' in cookie}")

        for endpoint, body in [
            ("account/account_menu", {}),
            ("browse", {"browseId": "FEmusic_liked_playlists"}),
        ]:
            status, payload = post(cookie, endpoint, body)
            print(f"\n{endpoint} -> HTTP {status}")
            if isinstance(payload, dict):
                if endpoint == "account/account_menu":
                    header = (
                        payload.get("actions", [{}])[0]
                        .get("openPopupAction", {})
                        .get("popup", {})
                        .get("multiPageMenuRenderer", {})
                        .get("header", {})
                        .get("activeAccountHeaderRenderer")
                    )
                    print("  activeAccountHeaderRenderer:", "yes" if header else "NO (anonymous)")
                if endpoint == "browse":
                    blob = json.dumps(payload)[:1500].lower()
                    print("  contains sign-in prompt:", "sign in" in blob)
            else:
                print(" ", payload)


if __name__ == "__main__":
    main()
