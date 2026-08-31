"use strict";

/*
 * コメント流量グラフ（モーダル表示）
 * カードの📊ボタンから開き、該当配信のコメントJSONを取得して1分バケットのグラフを描く。
 * 集計ロジックは拡張機能 sortcomments/commentgraph.js・kick-extension/js/commentchart.js の
 * 移植（重複除去→1分バケット→キーワード別カウント）。埋め込みプレイヤーは持たないため
 * currentTime連動やクリックシークは無い。
 *
 * キーワードはモーダル内の「キーワード集計」パネルでユーザーが編集でき、
 * localStorage (KEYWORDS_KEY) に保存して次回以降も使う。正規表現1件ずつを別の入力欄に
 * するのは、"8{3,}" のようなパターン自体にカンマを含むものがあり、カンマ区切りの
 * 1本の文字列では表現できないため。
 */

const KEYWORDS_KEY = "mokou-timeline:keywords";
const DEFAULT_KEYWORDS = ["草|w", "8{3,}", "^あ+$"];
// ダーク背景向けの原色はライトテーマの白背景では視認性が落ちる(特に cyan)ため、
// テーマごとに別の色セットを用意する (chartPalette 参照)。キーワード数がこれより
// 多い場合は色を使い回す (renderChart/renderKeywordRows で % による循環)。
const GRAPH_KEYWORD_COLORS_DARK = ["red", "orange", "cyan", "violet", "gold", "deeppink"];
const GRAPH_KEYWORD_COLORS_LIGHT = ["#c0392b", "#a06a00", "#0e7490", "#7c3aed", "#8a6d00", "#c2185b"];

function loadKeywords() {
  try {
    const raw = localStorage.getItem(KEYWORDS_KEY);
    if (!raw) return [...DEFAULT_KEYWORDS];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [...DEFAULT_KEYWORDS];
  } catch (e) {
    return [...DEFAULT_KEYWORDS];
  }
}
function saveKeywords(keywords) {
  try {
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify(keywords));
  } catch (e) {
    // プライベートブラウジング等で保存できなくても、セッション内の表示自体は継続する
  }
}
function isValidRegex(pattern) {
  try {
    new RegExp(pattern, "gi");
    return true;
  } catch (e) {
    return false;
  }
}

let currentKeywords = loadKeywords();

// resolvedTheme() は app.js 側で定義 (commentgraph.js は app.js の後に読み込まれる)。
function chartPalette() {
  const dark = resolvedTheme() === "dark";
  return {
    totalColor: dark ? "lime" : "#1a7a1a",
    keywordColors: dark ? GRAPH_KEYWORD_COLORS_DARK : GRAPH_KEYWORD_COLORS_LIGHT,
    legendColor: dark ? "#ccc" : "#333",
  };
}

const COMMENTS_BASE = {
  youtube: "https://tourist1159.github.io/youtube-comment-fetcher/comments_github/",
  kick: "https://tourist1159.github.io/kick-comment-fetcher/comments_github/",
};

let modalEls = null; // 初回オープン時に生成して使い回す
let currentChart = null;
let requestSeq = 0; // 連打時、古いレスポンスの描画を防ぐ
// キーワード編集時の再集計 (rerenderChart) 用。現在開いているグラフの重複除去済み
// コメントと配信長を持つ (モーダルを閉じたら closeCommentGraph が null に戻す)。
let lastFiltered = null;
let lastOffsetSec = null;
let lastItem = null;

function buildModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "graph-modal-backdrop";
  backdrop.hidden = true;

  const panel = document.createElement("div");
  panel.className = "graph-modal-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const header = document.createElement("div");
  header.className = "graph-modal-header";

  const title = document.createElement("h2");
  title.className = "graph-modal-title";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "graph-modal-close";
  closeBtn.setAttribute("aria-label", "閉じる");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", closeCommentGraph);

  header.appendChild(title);
  header.appendChild(closeBtn);

  const keywordEditor = buildKeywordEditor();

  const body = document.createElement("div");
  body.className = "graph-modal-body";

  const status = document.createElement("div");
  status.className = "graph-modal-status";

  const chartWrap = document.createElement("div");
  chartWrap.className = "graph-modal-chart";
  chartWrap.hidden = true;
  const canvas = document.createElement("canvas");
  chartWrap.appendChild(canvas);

  body.appendChild(status);
  body.appendChild(chartWrap);

  const footer = document.createElement("div");
  footer.className = "graph-modal-footer";
  const link = document.createElement("a");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "graph-modal-link";
  footer.appendChild(link);

  panel.appendChild(header);
  panel.appendChild(keywordEditor.details);
  panel.appendChild(body);
  panel.appendChild(footer);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeCommentGraph();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !backdrop.hidden) closeCommentGraph();
  });

  return { backdrop, panel, title, status, chartWrap, canvas, link, keywordEditor };
}

// ---- キーワード集計の編集パネル ----
// <details> なので開閉自体はブラウザ標準の挙動 (キーボード操作も含め) に任せる。
function buildKeywordEditor() {
  const details = document.createElement("details");
  details.className = "keyword-editor";

  const summary = document.createElement("summary");
  summary.className = "keyword-editor-summary";
  details.appendChild(summary);

  const bodyEl = document.createElement("div");
  bodyEl.className = "keyword-editor-body";

  const hint = document.createElement("p");
  hint.className = "keyword-editor-hint";
  hint.textContent =
    "正規表現でキーワードを指定できます（例: 草|w、8{3,}、^あ+$）。1分ごとの出現回数を数え、" +
    "全コメント数のグラフに重ねて表示します。";
  bodyEl.appendChild(hint);

  const list = document.createElement("div");
  list.className = "keyword-editor-list";
  bodyEl.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "keyword-editor-actions";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "keyword-add-btn";
  addBtn.textContent = "＋ キーワードを追加";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "keyword-reset-btn";
  resetBtn.textContent = "既定に戻す";
  actions.appendChild(addBtn);
  actions.appendChild(resetBtn);
  bodyEl.appendChild(actions);

  details.appendChild(bodyEl);

  const editor = { details, summary, list };

  addBtn.addEventListener("click", () => {
    currentKeywords.push("");
    onKeywordsChanged(editor);
    const inputs = list.querySelectorAll(".keyword-editor-input");
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  });
  resetBtn.addEventListener("click", () => {
    currentKeywords = [...DEFAULT_KEYWORDS];
    onKeywordsChanged(editor);
  });
  // 開くたびに作り直す。モーダル自体は使い回すため、開いている間にライト/ダークを
  // 切り替えても色のスウォッチ (chartPalette 由来) がその時点のテーマに追従するように。
  details.addEventListener("toggle", () => {
    if (details.open) renderKeywordRows(editor);
  });

  renderKeywordRows(editor);
  return editor;
}

function updateKeywordSummary(editor) {
  const active = currentKeywords.filter((w) => w.trim() !== "").length;
  editor.summary.textContent = `🔧 キーワード集計 (${active})`;
}

function renderKeywordRows(editor) {
  editor.list.textContent = "";
  const palette = chartPalette();
  currentKeywords.forEach((word, i) => {
    const row = document.createElement("div");
    row.className = "keyword-editor-row";

    const swatch = document.createElement("span");
    swatch.className = "keyword-color-swatch";
    swatch.style.background = palette.keywordColors[i % palette.keywordColors.length];
    row.appendChild(swatch);

    const input = document.createElement("input");
    input.type = "text";
    input.value = word;
    input.placeholder = "正規表現 (例: 草|w)";
    input.className = "keyword-editor-input";
    input.setAttribute("aria-label", `キーワード ${i + 1}`);
    if (word.trim() !== "" && !isValidRegex(word)) input.classList.add("invalid");
    input.addEventListener("input", () => {
      currentKeywords[i] = input.value;
      input.classList.toggle("invalid", input.value.trim() !== "" && !isValidRegex(input.value));
      saveKeywords(currentKeywords);
      updateKeywordSummary(editor);
      rerenderChart();
    });
    row.appendChild(input);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "keyword-remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.setAttribute("aria-label", `キーワード ${i + 1} を削除`);
    removeBtn.addEventListener("click", () => {
      currentKeywords.splice(i, 1);
      onKeywordsChanged(editor);
    });
    row.appendChild(removeBtn);

    editor.list.appendChild(row);
  });
  updateKeywordSummary(editor);
}

// 行の増減 (追加/削除/リセット) は一覧を丸ごと作り直す。1文字ごとの入力(input)は
// renderKeywordRows を呼ばない (フォーカスが飛ぶため、値の反映とサマリー更新だけ行う)。
function onKeywordsChanged(editor) {
  saveKeywords(currentKeywords);
  renderKeywordRows(editor);
  rerenderChart();
}

function closeCommentGraph() {
  if (!modalEls) return;
  modalEls.backdrop.hidden = true;
  if (currentChart) {
    try {
      currentChart.destroy();
    } catch (e) {}
    currentChart = null;
  }
  // キーワード編集中の再描画 (rerenderChart) が閉じたモーダルに対して走らないようにする
  lastFiltered = null;
  lastOffsetSec = null;
  lastItem = null;
}

// ---- コメントの正規化（プラットフォーム差異を吸収） ----
function normalizeComments(data, item) {
  const raw = data.comments || [];
  if (item.platform === "youtube") {
    return raw.map((c) => ({ offsetSec: c.offset, text: c.text, id: c.id }));
  }
  // kick: timestamp(絶対時刻) を start_time 基準の経過秒へ変換
  const videoStart = new Date(data.start_time || (raw[0] && raw[0].timestamp));
  return raw.map((c) => ({
    offsetSec: (new Date(c.timestamp) - videoStart) / 1000,
    text: c.text,
    id: c.id,
  }));
}

// ---- 重複除去（同一ユーザーの連投/類似文言を間引く） ----
function dedupComments(comments) {
  comments = comments.slice().sort((a, b) => a.offsetSec - b.offsetSec);
  const filtered = [];
  const lastByUser = new Map();

  for (const c of comments) {
    const uid = c.id;
    const text = (c.text || "").trim();
    const norm = normalizeText(text);
    const offset = c.offsetSec;
    let skip = false;

    for (const [key, value] of lastByUser.entries()) {
      if (offset - value.offset > 30) lastByUser.delete(key);
      else break;
    }

    const last = lastByUser.get(uid);
    if (last) {
      const diffSec = offset - last.offset;
      const lastNorm = normalizeText(last.text);
      if (diffSec <= 3) skip = true;
      if (lastNorm && (lastNorm.includes(norm) || norm.includes(lastNorm))) skip = true;
    }
    lastByUser.set(uid, { offset, text });
    if (!skip) filtered.push(c);
  }
  return filtered;
}

// ---- 1分バケット集計 ----
// keywords は文字列の配列を「そのまま」渡す (キーワード集計パネルの行と同じ並び・
// 同じ色になるようにするため)。空文字列や無効な正規表現の行も、位置を保ったまま
// 「常に0」のデータセットとして残す (削除しない限りグラフの色・凡例がズレないように)。
// 同じキーワードが2件入力された場合の衝突を避けるため、辞書ではなく配列で持つ。
function bucketComments(filtered, lastOffset, keywords) {
  const minutes = Math.max(1, Math.floor(lastOffset / 60) + 1);
  const totalCounts = new Array(minutes).fill(0);
  const keywordCounts = keywords.map(() => new Array(minutes).fill(0));

  for (const c of filtered) {
    const diffMin = Math.floor(c.offsetSec / 60);
    if (diffMin < 0 || diffMin >= minutes) continue;
    totalCounts[diffMin]++;
    const text = c.text || "";
    keywords.forEach((word, i) => {
      const pattern = (word || "").trim();
      if (!pattern) return;
      try {
        const matches = text.match(new RegExp(pattern, "gi"));
        if (matches && matches.length < 10) keywordCounts[i][diffMin] += matches.length;
      } catch (e) {
        /* 無効な正規表現は無視 (入力欄側は isValidRegex で赤枠にして知らせる) */
      }
    });
  }

  const labels = totalCounts.map((_, i) => {
    const h = Math.floor(i / 60);
    const m = i % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  });

  return { labels, totalCounts, keywordCounts };
}

function fmtHms(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

// YouTube の「開く」リンクに時刻ジャンプ(&t=Ns)を付与する。
// Kick は時刻付きURLを未サポートのため対象外（リンクは動画先頭のまま）。
function setYoutubeSeekLink(link, item, seconds) {
  try {
    const u = new URL(item.url);
    u.searchParams.set("t", Math.max(0, Math.round(seconds)) + "s");
    link.href = u.toString();
    link.textContent = `YouTubeで開く（${fmtHms(seconds)}〜）`;
  } catch (e) {
    /* URL解析に失敗した場合は何もしない */
  }
}

function renderChart(canvas, agg, item, link, keywords) {
  const ctx = canvas.getContext("2d");
  const palette = chartPalette();
  return new window.Chart(ctx, {
    type: "line",
    data: {
      labels: agg.labels,
      datasets: [
        {
          label: "全コメント",
          data: agg.totalCounts,
          borderColor: palette.totalColor,
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          yAxisID: "yTotal",
        },
        ...keywords.map((word, i) => ({
          label: word.trim() ? word : "(未入力)",
          data: agg.keywordCounts[i],
          borderColor: palette.keywordColors[i % palette.keywordColors.length],
          borderWidth: 1.5,
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          yAxisID: "yKeyword",
        })),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: {
          labels: { color: palette.legendColor, boxWidth: 12, font: { size: 11 } },
          onClick: (e, legendItem, legend) => {
            const ch = legend.chart;
            const di = legendItem.datasetIndex;
            ch.setDatasetVisibility(di, !ch.isDatasetVisible(di));
            ch.update();
          },
        },
        tooltip: {
          callbacks: { title: (items) => (items.length ? "経過 " + items[0].label : "") },
        },
      },
      onClick: (evt, _elements, chartInstance) => {
        if (item.platform !== "youtube") return; // Kick は時刻ジャンプ非対応
        const points = chartInstance.getElementsAtEventForMode(evt, "nearest", { intersect: false }, true);
        if (!points.length) return;
        const index = points[0].index; // 経過分（1分バケットのインデックス）
        setYoutubeSeekLink(link, item, index * 60);
      },
      scales: {
        x: { display: false },
        yTotal: {
          type: "linear", position: "left",
          ticks: { color: "lime" }, grid: { color: "#333" }, display: false,
        },
        yKeyword: {
          type: "linear", position: "right",
          ticks: { color: "orange" }, grid: { drawOnChartArea: false }, display: false,
        },
      },
    },
  });
}

async function openCommentGraph(item) {
  if (!modalEls) modalEls = buildModal();
  const { backdrop, title, status, chartWrap, canvas, link } = modalEls;
  const seq = ++requestSeq;

  if (currentChart) {
    try {
      currentChart.destroy();
    } catch (e) {}
    currentChart = null;
  }

  title.textContent = item.title;
  link.textContent = item.platform === "youtube" ? "YouTubeで開く" : "Kickで開く";
  link.href = item.url;
  chartWrap.hidden = true;
  status.hidden = false;
  status.textContent = "読み込み中…";
  backdrop.hidden = false;

  if (typeof window.Chart === "undefined") {
    status.textContent = "グラフライブラリの読み込みに失敗しました。";
    return;
  }
  if (!item.commentsKey) {
    status.textContent = "コメントデータがありません。";
    return;
  }

  const base = COMMENTS_BASE[item.platform];
  const url = `${base}${item.commentsKey}_comments.json`;

  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (seq !== requestSeq) return; // 別アイテムが開かれた
    if (!res.ok) {
      status.textContent = "コメントデータがありません（期限切れの可能性があります）。";
      return;
    }
    const data = await res.json();
    if (seq !== requestSeq) return;

    const comments = normalizeComments(data, item);
    if (!comments.length) {
      status.textContent = "コメントデータがありません。";
      return;
    }
    const filtered = dedupComments(comments);
    const lastOffset = comments[comments.length - 1].offsetSec;

    // キーワード編集パネルでの再集計 (rerenderChart) 用に保持しておく。
    // 再フェッチせずに済むので、入力のたびにネットワークへ行かない。
    lastFiltered = filtered;
    lastOffsetSec = lastOffset;
    lastItem = item;

    status.hidden = true;
    chartWrap.hidden = false;
    currentChart = renderChart(canvas, bucketComments(filtered, lastOffset, currentKeywords), item, link, currentKeywords);
  } catch (e) {
    if (seq !== requestSeq) return;
    console.error("[CommentGraph]", e);
    status.textContent = "コメントデータの取得に失敗しました。";
  }
}

// キーワードの追加/削除/編集のたびに呼ばれる。開いているグラフがあれば
// (フェッチし直さずに) その場で集計と描画をやり直す。
function rerenderChart() {
  if (!currentChart || !lastFiltered) return;
  try {
    currentChart.destroy();
  } catch (e) {}
  currentChart = renderChart(
    modalEls.canvas,
    bucketComments(lastFiltered, lastOffsetSec, currentKeywords),
    lastItem,
    modalEls.link,
    currentKeywords
  );
}

window.openCommentGraph = openCommentGraph;
