import re
import urllib.request

html = urllib.request.urlopen("https://music.youtube.com", timeout=15).read().decode(
    "utf-8", "replace"
)
for pattern in [
    r'INNERTUBE_CLIENT_VERSION":"([^"]+)"',
    r'"clientVersion":"([^"]+)"',
]:
    m = re.search(pattern, html)
    if m:
        print(m.group(1))
        break
else:
    print("not found")
