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

GitHub の cron (schedule イベント) はこの account では当てにならない。2026-08-29 に調べた
実測値では、各fetcherの `0 * * * *` が6〜12時間に1回しか発火せず、このワークフロー自身の
`*/15` も間引かれてライブ判定に3〜5時間の空白ができていた (run の created_at と
run_started_at が一致しているので、runnerの順番待ちではなくイベント自体が発火していない)。
原因は account 全体の Actions 実行量とみられ、live_status.json のコミットのたびに走る
pages-build-deployment が1週間で955 run に達していた。対策は2つ:
  1. コミット頻度を落とす (should_write / SIGNIFICANT_FIELDS)
  2. cron に頼らず、常時動いているこのループから起動する
     - `--dispatch-archives` … 各fetcherを毎時起動 (dispatch_archives)
     - `--dispatch-self`     … ループ終了時に次の run を起動 (dispatch_self)
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
# 自分自身 (ループの最後に次の run を起動するため)
SELF_REPO = "mokou-timeline"
SELF_WORKFLOW = "live-status.yml"

# 各fetcherを起動する最短間隔。前回の実行からこれ以上経っていれば起動する
# (元の毎時cron相当。配信終了検知による起動もこの「前回の実行」に含まれる)。
# 0 を渡すとこの定期起動を止める = 定期実行は fetcher 側の cron に任せる、という構成にできる
# (GitHub の schedule が正常に発火するようになったらそちらの方が素直)。
ARCHIVE_MIN_INTERVAL = int(os.environ.get("ARCHIVE_MIN_INTERVAL") or 3600)
DISPATCH_TARGETS = {
    ("kick", KICK_CHANNEL): ("kick-comment-fetcher", "fetch.yml"),
    ("twitch", TWITCH_CHANNEL): ("twitch-archive-fetcher", "fetch.yml"),
    ("youtube", "mokouliszt"): ("youtube-comment-fetcher", "meta-fetch.yml"),
    ("youtube", "mokoustream"): ("youtube-comment-fetcher", "meta-fetch.yml"),
}

# live_status.json を1回 commit するたびに Pages の再ビルド (pages-build-deployment) が
# 走る。実測(2026-08-29 調査)では live_status.json のコミットが1日300件を超え、
# pages-build-deployment だけで1週間 955 run に達していた。この account 全体の Actions
# 負荷のせいで GitHub のスケジューラに cron を間引かれ、各fetcherの「毎時」cron が
# 6〜12時間に1回しか発火しない状態になっていた (このワークフロー自身の */15 も同様で、
# ライブ判定に3〜5時間の空白ができていた)。そのため書き出す条件を絞る:
#   1. 意味のある変化 (配信の開始/終了、タイトルやURLの変化) → 即書き出す
#   2. viewers やサムネURLだけの変化 (配信中は毎分変わる) → VOLATILE_WRITE_SECONDS に1回
#   3. 何も変わらなくても HEARTBEAT_SECONDS 経過 → checked_at だけ更新 (死活確認用)
# サイト側は checked_at も viewers も使っていない(表示は title/url/thumbnail のみ)ので、
# 2・3 を長くしても見た目には影響しない。
SIGNIFICANT_FIELDS = ("platform", "channel", "title", "url", "videoId")
VOLATILE_WRITE_SECONDS = 1800
HEARTBEAT_SECONDS = 21600

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


def last_run_age(repo, workflow_file):
    """指定ワークフローの最新 run が何秒前に作られたかを返す (取れなければ None)。"""
    pat = os.environ.get("DISPATCH_PAT")
    if not pat:
        return None
    url = (
        f"https://api.github.com/repos/{GITHUB_OWNER}/{repo}"
        f"/actions/workflows/{workflow_file}/runs?per_page=1"
    )
    req = Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {pat}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "mokou-timeline-live-status",
        },
    )
    try:
        with urlopen(req, timeout=20) as res:
            runs = json.loads(res.read().decode("utf-8")).get("workflow_runs") or []
    except (HTTPError, URLError, json.JSONDecodeError) as e:
        print(f"⚠️ {repo}/{workflow_file} の最終実行時刻を取得できません: {e}")
        return None
    if not runs:
        return None
    created = parse_iso((runs[0].get("created_at") or "").replace("Z", "+00:00"))
    if created is None:
        return None
    return int((datetime.now(timezone.utc) - created).total_seconds())


def dispatch_archives(min_interval=ARCHIVE_MIN_INTERVAL):
    """各アーカイブ収集ワークフローを、前回実行から min_interval 秒経っていれば起動する。

    各fetcher側にも毎時cronはあるが、GitHub のスケジューラに間引かれて実際には
    6〜12時間に1回しか発火しない状態になっている(2026-08-29 実測)。常時動いている
    このループから叩けば、スケジューラの機嫌に関係なく毎時収集できる。

    「ループ開始からの経過時間」ではなく「対象ワークフローの最終実行時刻」を基準に
    するのは、この run 自体が cancel-in-progress で頻繁に作り直されるため。ループ内の
    タイマーだと再起動のたびに0に戻ってしまい、いつまでも起動されない/されすぎる。
    """
    if not min_interval:
        print("⏭ 定期起動は無効 (ARCHIVE_MIN_INTERVAL=0 / fetcher側のcronに任せる)")
        return
    for repo, workflow_file in sorted(set(DISPATCH_TARGETS.values())):
        age = last_run_age(repo, workflow_file)
        if age is not None and age < min_interval:
            print(f"⏭ {repo}/{workflow_file} は{age}秒前に実行済み (起動しない)")
            continue
        if age is None:
            print(f"[{repo}/{workflow_file}] 最終実行時刻が不明のため起動する")
        dispatch_workflow(repo, workflow_file)


def check_dispatch_permission():
    """DISPATCH_PAT で各ワークフローを起動できるかを、実際には起動せずに確認する。

    存在しない ref を指定して workflow_dispatch を投げると、
      - 権限あり → 422 (No ref found for: ...) … ref が無いので run は作られない
      - 権限なし → 403 (classic PATのスコープ不足) / 404 (fine-grained PATの対象外)
    が返る。副作用なしで「起動できるか」だけを判定できる。
    """
    pat = os.environ.get("DISPATCH_PAT")
    if not pat:
        print("❌ DISPATCH_PAT が未設定です")
        return
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {pat}",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "mokou-timeline-live-status",
    }
    # classic PAT ならスコープがヘッダで分かる (fine-grained PAT では出ない)
    try:
        with urlopen(Request("https://api.github.com/rate_limit", headers=headers), timeout=20) as res:
            scopes = res.headers.get("x-oauth-scopes")
        print(f"トークン種別: {'classic (scopes: ' + scopes + ')' if scopes else 'fine-grained もしくはスコープ非公開'}")
    except (HTTPError, URLError) as e:
        print(f"⚠️ トークンの確認に失敗: {e}")

    targets = sorted(set(DISPATCH_TARGETS.values())) + [(SELF_REPO, SELF_WORKFLOW)]
    for repo, workflow_file in targets:
        url = (
            f"https://api.github.com/repos/{GITHUB_OWNER}/{repo}"
            f"/actions/workflows/{workflow_file}/dispatches"
        )
        body = json.dumps({"ref": "___permission-probe-does-not-exist___"}).encode("utf-8")
        req = Request(url, data=body, method="POST", headers=headers)
        try:
            with urlopen(req, timeout=20) as res:
                # ここに来る = 実際に起動してしまった (通常は起こらない)
                print(f"⚠️ {repo}/{workflow_file}: HTTP {res.status} — 起動してしまった可能性あり")
        except HTTPError as e:
            if e.code == 422:
                print(f"✅ {repo}/{workflow_file}: 起動できる (Actions:write あり)")
            else:
                print(f"❌ {repo}/{workflow_file}: HTTP {e.code} — 起動できない (権限不足かrepo対象外)")
        except URLError as e:
            print(f"⚠️ {repo}/{workflow_file}: 確認できず ({e.reason})")


def dispatch_self():
    """自分自身(live-status.yml)の次の run を起動する。

    このワークフローは1 job を6時間近く回し続ける作りなので、次の run の起動を cron
    (*/15) に頼っていた。その cron も間引かれるようになり、実測でライブ判定に3〜5時間
    の空白ができていたため、ループの最後に自分で次を起動して数珠つなぎにする
    (cron は数珠が切れたときの保険として残す)。
    """
    dispatch_workflow(SELF_REPO, SELF_WORKFLOW)


# === 入出力 ===
def load_previous():
    try:
        with open(OUT_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def significant(live):
    """viewers やサムネURLのような「配信中ずっと変わり続ける値」を落とした比較用の形。"""
    return [tuple(x.get(f) for f in SIGNIFICANT_FIELDS) for x in live]


def should_write(prev, live):
    """live_status.json を書き出すべきか (書く理由) を返す。"""
    if not isinstance(prev, dict):
        return True, "既存ファイル無し"
    prev_live = prev.get("live") or []
    if significant(prev_live) != significant(live):
        return True, "ライブ状態が変化"
    prev_at = parse_iso(prev.get("checked_at"))
    if prev_at is None:
        return True, "checked_at が不正"
    age = int((datetime.now(timezone.utc) - prev_at).total_seconds())
    if prev_live != live and age >= VOLATILE_WRITE_SECONDS:
        return True, f"viewers/サムネの更新 ({age}秒経過)"
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
    # ライブ判定 (引数なし) 以外に、ワークフローから呼ぶ起動用のモードを持つ
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "--dispatch-archives":
        dispatch_archives()
    elif mode == "--dispatch-self":
        dispatch_self()
    elif mode == "--check-dispatch":
        check_dispatch_permission()
    else:
        main()
