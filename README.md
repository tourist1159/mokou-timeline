# mokou-timeline

もこうの **YouTube 動画・配信**と **Kick 配信**を、1つの時系列タイムラインでまとめて表示する
静的サイト（バニラ JS・ビルド不要・サーバ不要）。

## 仕組み

読み込み時に、既存の2つのバックエンドが GitHub Pages で配信している JSON を
ブラウザから直接取得し、共通形に正規化・統合して時系列表示する。

- YouTube: `https://tourist1159.github.io/youtube-comment-fetcher/youtube_archives.json`
- Kick: `https://tourist1159.github.io/kick-comment-fetcher/kick_archives.json`

サイト自身も同じ `tourist1159.github.io` に置くため**同一オリジン**で取得でき、CORS 不要。
データは各 fetcher が更新し続けるので、**サイトは再ビルド不要**（常に最新を表示）。

## 機能（v1）

- 統合タイムライン（新しい順／古い順トグル）
- フィルタ: 配信元（YouTube / Kick）・チャンネル・種別（配信 / 動画）
- タイトル検索
- 件数・期間の統計表示
- カード表示（サムネ・長さ・日時(JST)・バッジ・コメント数・元動画へのリンク）
- フィルタ/検索/並びは URL クエリに反映（共有可能）
- **コメント流量グラフ**: コメントデータがある配信（カードに📊ボタン）はクリックでモーダル表示。
  1分バケットの全コメント数＋キーワード別カウントを Chart.js で描画。埋め込みプレイヤーは
  持たないため、時刻クリックでのシークは無く「元動画を開く」リンクのみ（Kick は VOD ページを
  iframe化できない制約があるため、YouTube/Kick で同じ体験に揃えている）。
- **ライブ配信中インジケーター**: YouTube 2チャンネル・Kick のいずれかが配信中の場合、
  ページ上部に目立つ「LIVE」バナーで表示（サムネ・タイトル・Kickは視聴者数）。クリックで
  配信ページへ。1分間隔で `check_live.py`（Actions）が状態を更新し、サイト側も60秒間隔で
  ポーリングして反映する。

サムネイルは YouTube が動画 ID から生成、Kick は fetcher が保存した `thumbnail`（`images.kick.com`）
を使う。Kick で取得できないもの（削除済み動画）はプレースホルダー表示。

### 削除済み動画の扱い

Kick は約1ヶ月で古い VOD を削除するため、過去の配信は情報だけが残り動画は存在しない。
JSON の `available: false` がそれを示し、サイトでは**リンクを張らず**（クリック不可）
グレーアウト＋「削除済み」バッジで表示する。タイトル・日時・コメント数は記録として残る。
`available` が無いエントリは視聴可能として扱う（YouTube 側は現状フラグを持たない）。

## ファイル

- `index.html` … ページ構造
- `style.css` … ダークテーマ・レスポンシブ
- `app.js` … 取得→正規化→統合→描画→フィルタ/検索（先頭の `CONFIG` に取得先URL等を集約）
- `commentgraph.js` … コメント流量グラフのモーダル（取得→正規化→重複除去→1分バケット集計→描画）
- `chart/chart.umd.js` … Chart.js 本体（ローカル同梱、CDN 依存なし）
- `check_live.py` … YouTube/Kick/Twitch のライブ判定スクリプト（Actions が1分間隔で実行）
- `requirements.txt` … `check_live.py` が使う yt-dlp（YouTube のライブ判定に必要）
- `live_status.json` … `check_live.py` の出力。サイトが同一オリジンで読む
  （`{"checked_at":"...", "live":[{platform, channel, title, url, thumbnail, viewers?}]}`）

## ローカル確認

```bash
python -m http.server 8080
```

→ ブラウザで `http://localhost:8080/` を開く（`file://` 直開きは fetch がブロックされることがあるため
ローカルサーバ経由を推奨）。

## デプロイ（GitHub Pages）

1. このフォルダを新規 GitHub リポジトリ（Public）へ push。
2. Settings → Pages → Deploy from a branch → `main` / `/ (root)`。
3. `https://<user>.github.io/mokou-timeline/` で公開。

取得先リポジトリ名/アカウントを変える場合は `app.js` 先頭の `CONFIG.sources` を修正する。

Actions で `Live Status Checker` ワークフロー（`.github/workflows/live-status.yml`）が
自動的に1分間隔で `live_status.json` を更新する（Settings → Actions → Workflow permissions
を Read and write にしておくこと）。

## ライブ判定の仕組み（`check_live.py`）

- **YouTube**: yt-dlp の **flat 抽出**で `/channel/<id>/streams` タブの先頭数件を列挙し、
  `live_status == "is_live"` があればライブ中とみなす。タイトル・動画IDも同時に取れる
  （サムネイルは動画IDから `i.ytimg.com` の URL を直接構築）。
  以前は `/channel/<id>/live` の HTML を読んでいたが、**GitHub Actions のランナーIPからだと
  配信中でもライブの痕跡が返らない**ことが実測で判明した（`<link rel="canonical">` が文字列
  `"undefined"`、視聴ページの再生情報 `videoDetails` ごと欠落。ページ自体は1.1MB前後あり
  同意ウォールでも bot ブロックでもない＝ローカルIPからは正常。HTML をどう解析しても
  Actions 上では判定できない）。flat 抽出（タブの一覧取得のみ／1件ずつのフル抽出はしない）は
  youtube-comment-fetcher の meta-fetch が同じ Actions 上で常用していて bot 判定を受けて
  いない実績があるため、こちらに寄せた。
- **Kick**: `https://kick.com/api/v2/channels/<slug>/livestream` の `data` を見る
  （配信中はオブジェクト、非配信時は `null`）。
- **Twitch**: Helix API の `GET /helix/streams?user_login=<login>`（`TWITCH_CLIENT_ID` /
  `TWITCH_CLIENT_SECRET` が要る。未設定なら静かにスキップ）。
- **判定できなかったとき**（取得エラー等）は「配信していない」とはせず、直前の状態を最大15分
  引き継ぐ。一時的な失敗で LIVE バナーが消えたり、「配信終了」の誤検知でアーカイブ収集の
  Actions が無駄に起動したりするのを防ぐため。

## 今後（候補）

- コメント流量グラフに埋め込みプレイヤー＋時刻クリックでシーク（YouTube のみ実現可能。
  Kick は VOD ページが `X-Frame-Options: SAMEORIGIN` のため iframe 埋め込み不可）
- YouTube 収集窓（`USER_START_DATE`）を過去へ拡張して Kick と期間を揃える
