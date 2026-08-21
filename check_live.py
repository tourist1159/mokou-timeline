"""
YouTube (2チャンネル) / Kick が現在ライブ配信中かどうかを調べ、live_status.json に書き出す。

- YouTube: https://www.youtube.com/channel/<id>/live を取得し、HTML内の
  <link rel="canonical"> を見る。非ライブ時はチャンネルページのまま、ライブ中は
  /watch?v=<videoId> になる (実測で確認済み)。yt-dlp/innertube API を使わない単純な
  ページ取得なので、GitHub Actions のデータセンターIPでも bot 判定されにくい。
- Kick: https://kick.com/api/v2/channels/<slug> の `livestream` フィールドを見る
  (配信中はオブジェクト、非配信時は null。実測で確認済み)。
- Twitch: Helix API の `GET /helix/streams?user_login=<login>` を見る (配信中は
  data が非空、非配信時は空配列)。App Access Token (Client Credentials Flow) が要る
  ので TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET を環境変数(Secrets)で渡す。未設定でも
  他プラットフォームの判定は継続する(静かにスキップ)。

このスクリプトは mokou-timeline 内で完結させる (1分間隔などの頻繁な実行が必要なため、
アーカイブ収集用の各fetcherリポジトリとは別に、時系列サイト自身が「今」の状態を持つ)。

Actions からは 1 run のなかで 1 分おきに繰り返し呼ばれる (cron の最小粒度が5分のため)。
そのため「変化が無いときは live_status.json を書き換えない」= commit/push しない、という
挙動にしてある (下の should_write を参照)。
"""

import json
import re
import sys
import functools
import html as html_module
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

print = functools.partial(print, file=sys.stderr, flush=True)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)

YOUTUBE_CHANNELS = [
    {"handle": "mokouliszt",  "channel_id": "UCZFxcWJS1_iVIFETARRRHZQ"},
    {"handle": "mokoustream", "channel_id": "UCENoC6MLc4pL-vehJyzSWmg"},
]
KICK_CHANNEL = "mokoutoaruotoko"
TWITCH_CHANNEL = "mokouliszt1"

OUT_FILE = "live_status.json"

# 変化が無いのに書き換えると毎分 commit/push が走ってしまうので、状態が同じあいだは
# ファイルに触らない。ただし完全に止めると「最後にいつ確認できたか」が分からなくなるため、
# この秒数以上経っていれば checked_at だけの更新でも書き出す (死活確認用の heartbeat)。
HEARTBEAT_SECONDS = 900

CANONICAL_RE = re.compile(r'<link rel="canonical" href="([^"]+)"')
# 実測の結果、/channel/<id>/live には og:title/og:image が無く、
# <meta name="title" content="..."> と <title>...</title> のみ存在する。
META_TITLE_RE = re.compile(r'<meta name="title" content="([^"]+)"')
TITLE_TAG_RE = re.compile(r"<title>([^<]+)</title>")
VIDEO_ID_RE = re.compile(r"v=([\w-]{11})")


def fetch(url, headers=None):
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    if headers:
        h.update(headers)
    req = Request(url, headers=h)
    with urlopen(req, timeout=20) as res:
        return res.read().decode("utf-8", "replace")


def check_youtube_live(channel_id, handle):
    url = f"https://www.youtube.com/channel/{channel_id}/live"
    try:
        page = fetch(url)
    except (HTTPError, URLError) as e:
        print(f"[youtube/{handle}] 取得エラー: {e}")
        return None

    m = CANONICAL_RE.search(page)
    canonical = m.group(1) if m else ""
    if "/watch" not in canonical:
        return None  # ライブ中でない

    vid_m = VIDEO_ID_RE.search(canonical)
    if not vid_m:
        return None
    video_id = vid_m.group(1)

    title = extract_youtube_title(page)

    return {
        "platform": "youtube",
        "channel": handle,
        "title": title,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "videoId": video_id,
        # サムネイルは動画IDから直接構築する (ページ内に og:image 等が無いため)。
        "thumbnail": f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg",
    }


def extract_youtube_title(page):
    m = META_TITLE_RE.search(page)
    if m:
        return html_module.unescape(m.group(1))
    m = TITLE_TAG_RE.search(page)
    if m:
        t = html_module.unescape(m.group(1))
        return re.sub(r"\s*-\s*YouTube$", "", t)
    return "配信中"


def check_kick_live():
    url = f"https://kick.com/api/v2/channels/{KICK_CHANNEL}"
    try:
        body = fetch(url, headers={"Accept": "application/json", "Referer": "https://kick.com/"})
        data = json.loads(body)
    except (HTTPError, URLError) as e:
        print(f"[kick] 取得エラー: {e}")
        return None
    except json.JSONDecodeError as e:
        print(f"[kick] JSON解析エラー: {e}")
        return None

    ls = data.get("livestream")
    if not ls:
        return None  # ライブ中でない

    title = ls.get("session_title") or ls.get("title") or "配信中"
    thumb_obj = ls.get("thumbnail") or {}
    thumbnail = thumb_obj.get("url") or thumb_obj.get("src") if isinstance(thumb_obj, dict) else None
    viewers = ls.get("viewer_count") or ls.get("viewers")

    return {
        "platform": "kick",
        "channel": KICK_CHANNEL,
        "title": title,
        "url": f"https://kick.com/{KICK_CHANNEL}",
        "thumbnail": thumbnail,
        "viewers": viewers,
    }


def get_twitch_app_token():
    client_id = os.environ.get("TWITCH_CLIENT_ID")
    client_secret = os.environ.get("TWITCH_CLIENT_SECRET")
    if not client_id or not client_secret:
        return None
    body = urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "client_credentials",
        }
    ).encode()
    req = Request("https://id.twitch.tv/oauth2/token", data=body, method="POST")
    try:
        with urlopen(req, timeout=20) as res:
            return json.loads(res.read().decode("utf-8"))["access_token"]
    except (HTTPError, URLError) as e:
        print(f"[twitch] トークン取得エラー: {e}")
        return None


def check_twitch_live():
    client_id = os.environ.get("TWITCH_CLIENT_ID")
    token = get_twitch_app_token()
    if not client_id or not token:
        return None  # Secret未設定でも他プラットフォームは動かす

    url = f"https://api.twitch.tv/helix/streams?user_login={TWITCH_CHANNEL}"
    try:
        body = fetch(url, headers={"Client-Id": client_id, "Authorization": f"Bearer {token}"})
        data = json.loads(body).get("data") or []
    except (HTTPError, URLError) as e:
        print(f"[twitch] 取得エラー: {e}")
        return None
    except json.JSONDecodeError as e:
        print(f"[twitch] JSON解析エラー: {e}")
        return None

    if not data:
        return None  # ライブ中でない

    s = data[0]
    thumbnail = (s.get("thumbnail_url") or "").replace("%{width}", "320").replace("%{height}", "180")

    return {
        "platform": "twitch",
        "channel": TWITCH_CHANNEL,
        "title": s.get("title") or "配信中",
        "url": f"https://www.twitch.tv/{TWITCH_CHANNEL}",
        "thumbnail": thumbnail or None,
        "viewers": s.get("viewer_count"),
    }


def load_previous():
    try:
        with open(OUT_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def should_write(prev, live):
    """live_status.json を書き出すべきか (書く理由) を返す。"""
    if not isinstance(prev, dict):
        return True, "既存ファイル無し"
    if prev.get("live") != live:
        return True, "ライブ状態が変化"
    try:
        prev_at = datetime.fromisoformat(prev["checked_at"])
    except (KeyError, TypeError, ValueError):
        return True, "checked_at が不正"
    if prev_at.tzinfo is None:
        prev_at = prev_at.replace(tzinfo=timezone.utc)
    age = int((datetime.now(timezone.utc) - prev_at).total_seconds())
    if age >= HEARTBEAT_SECONDS:
        return True, f"heartbeat ({age}秒経過)"
    return False, "変化なし"


def main():
    live = []
    for ch in YOUTUBE_CHANNELS:
        r = check_youtube_live(ch["channel_id"], ch["handle"])
        if r:
            live.append(r)
            print(f"[youtube/{ch['handle']}] ライブ中: {r['title'][:40]}")

    k = check_kick_live()
    if k:
        live.append(k)
        print(f"[kick] ライブ中: {k['title'][:40]}")

    t = check_twitch_live()
    if t:
        live.append(t)
        print(f"[twitch] ライブ中: {t['title'][:40]}")

    write, reason = should_write(load_previous(), live)
    if not write:
        print(f"⏭ {OUT_FILE} 据え置き ({reason} / ライブ中: {len(live)} 件)")
        return

    out = {"checked_at": datetime.now(timezone.utc).isoformat(), "live": live}
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"📁 {OUT_FILE} 更新完了 ({reason} / ライブ中: {len(live)} 件)")


if __name__ == "__main__":
    main()
