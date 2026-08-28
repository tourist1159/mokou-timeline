"""
YouTube (2チャンネル) / Kick / Twitch が現在ライブ配信中かどうかを調べ、live_status.json に書き出す。

- YouTube: yt-dlp の **flat 抽出**で `/channel/<id>/streams` タブの先頭数件を列挙し、
  `live_status == "is_live"` のエントリがあればライブ中とみなす。
  以前は `/channel/<id>/live` の HTML を直接読んでいたが、GitHub Actions のランナーIPから
  だとこのページが壊れた形で返ってくる(ローカルからは再現しない)ことが実測で確認された:
    * `<link rel="canonical">` が文字列 `"undefined"` になる
    * 視聴ページの再生情報 (`"videoDetails":{...,"isLive":true}`) が埋め込まれない
  ページ自体は 1.1MB 前後あり ytInitialData も同意ウォールも正常なので、bot ブロックの
  ページを掴まされているわけではなく、`/live` の解決結果だけが欠けた状態で返ってくる。
  つまり **HTML をどう解析しても Actions 上では判定できない**。
  一方 flat 抽出 (タブの一覧取得のみ、1件ずつのフル extract_info はしない) は
  youtube-comment-fetcher の meta-fetch が同じ Actions 上で常用していて bot 判定を
  受けていない実績があるため、こちらに寄せた。念のため旧方式のページ取得も残してあるが、
  「ライブである」という肯定の手掛かりを拾う用途だけに使う (下記 UNKNOWN を参照)。
- Kick: https://kick.com/api/v2/channels/<slug>/livestream の `data` を見る
  (配信中はオブジェクト、非配信時は null。実測で確認済み)。
- Twitch: Helix API の `GET /helix/streams?user_login=<login>` を見る (配信中は
  data が非空、非配信時は空配列)。App Access Token (Client Credentials Flow) が要る
  ので TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET を環境変数(Secrets)で渡す。未設定でも
  他プラットフォームの判定は継続する(静かにスキップ)。

各 check_xxx_live() の戻り値は3値:
  dict    … ライブ中 (live_status.json に載せるエントリ)
  None    … ライブ中でないと確定できた
  UNKNOWN … 判定できなかった (取得エラー等)
UNKNOWN のときは直前の状態を引き継ぐ。一時的な通信エラーで LIVE バナーが消えたり、
下記の「配信終了」誤検知でアーカイブ収集が無駄に起動したりするのを避けるため。
ただし引き継ぎっぱなしで固まらないよう STALE_SECONDS で打ち切る。

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

try:
    from yt_dlp import YoutubeDL
except ImportError:  # ローカルで未インストールでも、ページ取得のフォールバックだけは動かす
    YoutubeDL = None

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

# 「判定できなかった」を表す番兵 (None = 「ライブでないと確定」と区別する)
UNKNOWN = "unknown"

# /streams タブの先頭から何件見るか。配信中のものは基本的に先頭だが、予定(is_upcoming)の
# 配信が上に並ぶことがあるので少し余裕を持たせる。
STREAMS_SCAN = 5

# UNKNOWN が続いたときに直前のライブ状態を引き継ぐ上限。これを超えたら諦めて取り下げる
# (YouTube 側で本当に終わっているのに LIVE バナーが出っぱなしになるのを防ぐ)。
STALE_SECONDS = 900

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

# 実測の結果、/channel/<id>/live には og:title/og:image が無く、
# <meta name="title" content="..."> と <title>...</title> のみ存在する。
META_TITLE_RE = re.compile(r'<meta name="title" content="([^"]+)"')
TITLE_TAG_RE = re.compile(r"<title>([^<]+)</title>")
# 視聴ページの再生情報 (videoId の直後に isLive が来る)。ローカルIPからは取れるが、
# Actions のIPからは丸ごと欠落する (モジュール冒頭の説明を参照)。
VIDEO_DETAILS_RE = re.compile(r'"videoDetails":\{"videoId":"([\w-]{11})".{0,200}?"isLive":(true|false)')


def fetch(url, headers=None):
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    if headers:
        h.update(headers)
    req = Request(url, headers=h)
    with urlopen(req, timeout=20) as res:
        return res.read().decode("utf-8", "replace")


# === YouTube ===
def list_recent_streams(channel_id, handle):
    """/streams タブの新しい順 STREAMS_SCAN 件を flat 抽出する。失敗時は None。

    extract_flat = 一覧の取得のみで、1件ずつのフル extract_info (innertube の player
    呼び出し) はしない。過去に bot 判定を受けたのは後者であり、flat 抽出は Actions 上
    でも通っている (youtube-comment-fetcher の meta-fetch で実績あり)。
    """
    if YoutubeDL is None:
        print(f"[youtube/{handle}] yt-dlp が未インストール (pip install yt-dlp)")
        return None

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "playlistend": STREAMS_SCAN,
        "socket_timeout": 20,
    }
    url = f"https://www.youtube.com/channel/{channel_id}/streams"
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:  # yt-dlp の例外は種類が多いので広く捕まえる
        print(f"[youtube/{handle}] yt-dlp 列挙に失敗: {type(e).__name__}: {e}")
        return None

    entries = []
    for i, e in enumerate((info or {}).get("entries") or []):
        if i >= STREAMS_SCAN:
            break
        if e:
            entries.append(e)
    return entries


def check_youtube_live(channel_id, handle):
    entries = list_recent_streams(channel_id, handle)
    if entries is not None:
        for e in entries:
            # is_live 以外は not_live / was_live / is_upcoming (予定枠は出さない)
            if e.get("live_status") == "is_live" and e.get("id"):
                return youtube_entry(handle, e["id"], e.get("title"))
        return None  # ライブ中でないと確定

    # yt-dlp が使えなかったときだけ、旧方式のページ取得を試す。ただし Actions のIPからは
    # ライブ中でも痕跡が返らないことが分かっているので、「ライブである」という肯定の
    # 手掛かりだけ採用し、見つからない場合は「ライブでない」とは断定しない。
    hit = check_youtube_live_via_page(channel_id, handle)
    return hit if hit else UNKNOWN


def check_youtube_live_via_page(channel_id, handle):
    url = f"https://www.youtube.com/channel/{channel_id}/live"
    try:
        page = fetch(url)
    except (HTTPError, URLError) as e:
        print(f"[youtube/{handle}] ページ取得エラー: {e}")
        return None

    m = VIDEO_DETAILS_RE.search(page)
    if not m or m.group(2) != "true":
        return None
    return youtube_entry(handle, m.group(1), extract_youtube_title(page))


def youtube_entry(handle, video_id, title):
    return {
        "platform": "youtube",
        "channel": handle,
        "title": title or "配信中",
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "videoId": video_id,
        # サムネイルは動画IDから直接構築する (どの取得経路でも同じURLになるようにするため)。
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


# === Kick ===
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
        return UNKNOWN
    except json.JSONDecodeError as e:
        print(f"[kick] JSON解析エラー: {e}")
        return UNKNOWN

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


# === Twitch ===
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
    if not client_id or not os.environ.get("TWITCH_CLIENT_SECRET"):
        return None  # Secret未設定でも他プラットフォームは動かす
    token = get_twitch_app_token()
    if not token:
        return UNKNOWN  # Secretはあるのに取れなかった = 一時的な失敗

    url = f"https://api.twitch.tv/helix/streams?user_login={TWITCH_CHANNEL}"
    try:
        body = fetch(url, headers={"Client-Id": client_id, "Authorization": f"Bearer {token}"})
        data = json.loads(body).get("data") or []
    except (HTTPError, URLError) as e:
        print(f"[twitch] 取得エラー: {e}")
        return UNKNOWN
    except json.JSONDecodeError as e:
        print(f"[twitch] JSON解析エラー: {e}")
        return UNKNOWN

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


# === 判定不能時の引き継ぎ ===
def parse_iso(value):
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def carry_over(prev_live, key, now):
    """判定不能だったチャンネルについて、直前のライブエントリを引き継ぐ (無ければ None)。

    引き継いだエントリには stale_since (最初に判定不能になった時刻) を持たせ、
    STALE_SECONDS を超えたら諦める。
    """
    platform, channel = key
    prev_entry = next(
        (x for x in (prev_live or []) if (x.get("platform"), x.get("channel")) == key), None
    )
    if not prev_entry:
        # 元々ライブでないなら、判定不能でも出力は「ライブでない」と変わらない
        print(f"[{platform}/{channel}] 判定不能 (直前もライブでないため影響なし)")
        return None

    since = prev_entry.get("stale_since") or now.isoformat()
    since_dt = parse_iso(since) or now
    age = int((now - since_dt).total_seconds())
    if age >= STALE_SECONDS:
        print(f"[{platform}/{channel}] 判定不能が{age}秒続いたためライブ表示を取り下げ")
        return None

    print(f"[{platform}/{channel}] 判定不能 — 直前のライブ状態を維持 ({age}秒経過)")
    return dict(prev_entry, stale_since=since)


# === 配信終了検知 ===
def detect_ended(prev_live, live):
    """直前は配信中だったが今回は配信中でなくなった (platform, channel) の集合を返す。

    判定不能 (UNKNOWN) のチャンネルは carry_over で live 側に残るため、ここには出て
    こない = 一時的な取得エラーで誤って「終了」と判定することはない。
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


# === 入出力 ===
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
    prev_at = parse_iso(prev.get("checked_at"))
    if prev_at is None:
        return True, "checked_at が不正"
    age = int((datetime.now(timezone.utc) - prev_at).total_seconds())
    if age >= HEARTBEAT_SECONDS:
        return True, f"heartbeat ({age}秒経過)"
    return False, "変化なし"


def check_all():
    """(platform, channel) をキーに全プラットフォームを判定する。出力順を固定するためリストで返す。"""
    results = []
    for ch in YOUTUBE_CHANNELS:
        results.append((("youtube", ch["handle"]), check_youtube_live(ch["channel_id"], ch["handle"])))
    results.append((("kick", KICK_CHANNEL), check_kick_live()))
    results.append((("twitch", TWITCH_CHANNEL), check_twitch_live()))
    return results


def main():
    prev = load_previous()
    prev_live = prev.get("live") if isinstance(prev, dict) else None
    now = datetime.now(timezone.utc)

    live = []
    for key, result in check_all():
        if result == UNKNOWN:
            carried = carry_over(prev_live, key, now)
            if carried:
                live.append(carried)
        elif result:
            live.append(result)
            print(f"[{key[0]}/{key[1]}] ライブ中: {result['title'][:40]}")

    dispatch_ended_streams(prev_live, live)

    write, reason = should_write(prev, live)
    if not write:
        print(f"⏭ {OUT_FILE} 据え置き ({reason} / ライブ中: {len(live)} 件)")
        return

    out = {"checked_at": now.isoformat(), "live": live}
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"📁 {OUT_FILE} 更新完了 ({reason} / ライブ中: {len(live)} 件)")


if __name__ == "__main__":
    main()
