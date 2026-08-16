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

YouTube のサムネは動画 ID から取得。Kick はサムネ未保存のためプレースホルダー表示。

## ファイル

- `index.html` … ページ構造
- `style.css` … ダークテーマ・レスポンシブ
- `app.js` … 取得→正規化→統合→描画→フィルタ/検索（先頭の `CONFIG` に取得先URL等を集約）

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

## 今後（phase 2 候補）

- YouTube 配信のコメント流量グラフ詳細表示（`commentgraph.js` + Chart.js の再利用）
- Kick サムネの実取得（kick-comment-fetcher 拡張）
- YouTube 収集窓（`USER_START_DATE`）を過去へ拡張して Kick と期間を揃える
