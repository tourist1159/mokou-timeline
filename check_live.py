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

さらに、このスクリプトは「配信終了」を検知した瞬間に対応するアーカイブ収集リポジトリの
Actions を workflow_dispatch で起動する (dispatch_ended_streams 以下)。各アーカイブ収集は
毎時cronで独自にも動くが、それだと配信終了から最大1時間待たされる。ここは1分間隔で回って
いる (live-status.yml) ので、終了検知からすぐ収集を始められる。GitHub REST API を叩くのに
DISPATCH_PAT (対象repoへの Actions:write 権限を持つ PAT) が要る。未設定でも通常のライブ
判定自体は継続する(起動だけ諦める)。
  - Kick 終了 → kick-comment-fetcher の fetch.yml
  - Twitch 終了 → twitch-archive-fetcher の fetch.yml
  - YouTube 終了 (どちらかのチャンネル) → youtube-comment-fetcher の meta-fetch.yml
    (コメント取得本体は bot判定回避のためローカル専用なのでここでは起動しない。
    メタ情報だけでも早く反映されれば、タイムラインにはタイトル・サムネがすぐ出る)

このスクリプトは mokou-timeline 内で完結させる (1分間隔などの頻繁な実行が必要なため、
アーカイブ収集用の各fetcherリポジトリとは別に、時系列サイト自身が「今」の状態を持つ)。

Actions からは 1 run のなかで 1 分おきに繰り返し呼ばれる (cron の最小粒度が5分のため)。
そのため「変化が無いときは live_status.json を書き換えない」= commit/push しない、という
挙動にしてある (下の should_write を参照)。
"""

import json
import os
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

# 配信終了検知 → 起動するアーカイブ収集repoの対応表 (platform, channel) -> (repo, workflow_file)
GITHUB_OWNER = "tourist1159"
DISPATCH_TARGETS = {
    ("kick", KICK_CHANNEL): ("kick-comment-fetcher", "fetch.yml"),
    ("twitch", TWITCH_CHANNEL): ("twitch-archive-fetcher", "fetch.yml"),
    ("youtube", "mokouliszt"): ("youtube-comment-fetcher", "meta-fetch.yml"),
    ("youtube", "mokoustream"): ("youtube-comment-fetcher", "meta-fetch.yml"),
}

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


def extract_canonical(page):
    m = CANONICAL_RE.search(page)
    return m.group(1) if m else ""


def check_youtube_live(channel_id, handle):
    url = f"https://www.youtube.com/channel/{channel_id}/live"
    try:
        # CONSENT cookie: 地域(GitHub Actionsランナーの出口IPがEU圏になった場合など)に
        # よっては本来のチャンネルページの代わりに同意画面が返り、canonical が /watch に
        # ならず「ライブ中でない」と誤判定することがある(既知のYouTubeスクレイピング事情)。
        # このcookieを常時付与して同意画面をスキップする。
        page = fetch(url, headers={"Cookie": "CONSENT=YES+1"})
        canonical = extract_canonical(page)
        if not canonical or canonical == "undefined":
            # このcookie自体が逆に不完全なページ(canonicalが文字列"undefined"になる等)を
            # 引き起こすことがあるかもしれないので、cookie無しでも再取得してみる。
            print(f"[youtube/{handle}] canonicalが不正 ({canonical!r}) のため cookie 無しで再取得")
            page = fetch(url)
            canonical = extract_canonical(page)
        if not canonical or canonical == "undefined":
            # cookieの有無に関わらず不正 = cookie は原因ではない。次回の原因特定のため、
            # ページの手がかりをできるだけ残しておく。
            idx = page.find('href="undefined"')
            context = page[max(0, idx - 150) : idx + 150] if idx != -1 else "(該当箇所なし)"
            print(
                f"[youtube/{handle}] cookie無しでも不正 (cookieは原因でない)。"
                f"page_len={len(page)} "
                f"has_ytInitialData={'ytInitialData' in page} "
                f"has_consent_wall={'consent.youtube.com' in page or 'Before you continue' in page} "
                f"context={context!r}"
            )
    except (HTTPError, URLError) as e:
        print(f"[youtube/{handle}] 取得エラー: {e}")
        return None

    if "/watch" not in canonical:
        # 誤判定の切り分け用に、何が返ってきたか分かるようにしておく
        print(f"[youtube/{handle}] ライブ中でない (canonical={canonical!r})")
        return None  # ライブ中でない

    vid_m = VIDEO_ID_RE.search(canonical)
    if not vid_m:
        print(f"[youtube/{handle}] canonicalにvideoIdが見つからない: {canonical!r}")
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
    # /api/v2/channels/<slug> の livestream.thumbnail は配信中でも常に null で
    # 実際のサムネイルが取れない(実測で確認済み)。専用の /livestream サブエンドポイント
    # なら配信中の実サムネイル(thumbnail.src、数分おきに更新される版のURL)が取れる。
    # 配信外は {"data": null} を返すので、そのままライブ判定にも使える。
    url = f"https://kick.com/api/v2/channels/{KICK_CHANNEL}/livestream"
    try:
        body = fetch(url, headers={"Accept": "application/json", "Referer": "https://kick.com/"})
        data = json.loads(body)
    except (HTTPError, URLError) as e:
        print(f"[kick] 取得エラー: {e}")
        return None
    except json.JSONDecodeError as e:
        print(f"[kick] JSON解析エラー: {e}")
        return None

    ls = data.get("data")
    if not ls:
        return None  # ライブ中でない

    title = ls.get("session_title") or ls.get("title") or "配信中"
    thumb_obj = ls.get("thumbnail") or {}
    thumbnail = thumb_obj.get("src") or thumb_obj.get("url") if isinstance(thumb_obj, dict) else None
    viewers = ls.get("viewers") or ls.get("viewer_count")

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


def detect_ended(prev_live, live):
    """直前は配信中だったが今回は配信中でなくなった (platform, channel) の集合を返す。

    注意: check_xxx_live() は「配信中でない」と「取得エラー」を区別せず両方 None を
    返すため、一時的な通信エラーでも誤って「終了」判定される可能性がある。実害は
    アーカイブ収集を少し早めに起動するだけ(収集側は差分が無ければ何もしない)なので、
    ここでは簡易な判定のまま許容している。
    """
    prev_keys = {(x.get("platform"), x.get("channel")) for x in (prev_live or [])}
    now_keys = {(x.get("platform"), x.get("channel")) for x in live}
    return prev_keys - now_keys


def dispatch_workflow(repo, workflow_file):
    pat = os.environ.get("DISPATCH_PAT")
    if not pat:
        print(f"⚠️ DISPATCH_PAT 未設定のため {repo}/{workflow_file} を起動できません (次回の定期実行を待ちます)")
        return
    url = f"https://api.github.com/repos/{GITHUB_OWNER}/{repo}/actions/workflows/{workflow_file}/dispatches"
    body = json.dumps({"ref": "main"}).encode("utf-8")
    req = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {pat}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(req, timeout=20) as res:
            print(f"🚀 {repo}/{workflow_file} を起動 (HTTP {res.status})")
    except HTTPError as e:
        print(f"❌ {repo}/{workflow_file} の起動に失敗: HTTP {e.code} {e.read().decode('utf-8', 'replace')}")
    except URLError as e:
        print(f"❌ {repo}/{workflow_file} の起動に失敗: {e.reason}")


def dispatch_ended_streams(prev_live, live):
    ended = detect_ended(prev_live, live)
    if not ended:
        return
    targets = {DISPATCH_TARGETS[k] for k in ended if k in DISPATCH_TARGETS}
    for platform, channel in ended:
        print(f"🔚 [{platform}/{channel}] 配信終了を検知")
    for repo, workflow_file in targets:
        dispatch_workflow(repo, workflow_file)


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
    prev = load_previous()
    prev_live = prev.get("live") if isinstance(prev, dict) else None

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

    dispatch_ended_streams(prev_live, live)

    write, reason = should_write(prev, live)
    if not write:
        print(f"⏭ {OUT_FILE} 据え置き ({reason} / ライブ中: {len(live)} 件)")
        return

    out = {"checked_at": datetime.now(timezone.utc).isoformat(), "live": live}
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"📁 {OUT_FILE} 更新完了 ({reason} / ライブ中: {len(live)} 件)")


if __name__ == "__main__":
    main()
