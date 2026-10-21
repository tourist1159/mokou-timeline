"use strict";

/*
 * 詳細情報ポップアップ（カードのサムネ以外をクリックすると開くモーダル）
 * 日時・種別・再生数・コメント数などカードに出ている情報に加え、YouTubeの動画/配信は
 * タグを、配信はコメント流量グラフを表示する。
 *
 * グラフ部分は該当配信のコメントJSONを取得して1分バケットで描く。集計ロジックは拡張機能
 * sortcomments/commentgraph.js・kick-extension/js/commentchart.js の移植
 * （重複除去→1分バケット→キーワード別カウント）。埋め込みプレイヤーは持たないため
 * currentTime連動やクリックシークは無い。
 *
 * キーワードはモーダル内の「キーワード集計」パネルでユーザーが編集でき、
 * localStorage (KEYWORDS_KEY) に保存して次回以降も使う。正規表現1件ずつを別の入力欄に
 * するのは、"8{3,}" のようなパターン自体にカンマを含むものがあり、カンマ区切りの
 * 1本の文字列では表現できないため。
 *
 * グラフ凡例をクリックして各キーワードの線をオン/オフする状態も localStorage
 * (HIDDEN_KEYWORDS_KEY) に保存し、別の配信・次回の訪問でも引き継ぐ。
 */

const KEYWORDS_KEY = "mokou-timeline:keywords";
// グラフ凡例でオフにしたキーワード (キーワード文字列そのものをキーにする。
// 「オンのものだけ覚える」ではなく「オフのものだけ覚える」ことで、新しく追加した
// キーワードは何もしなくても既定でオン=表示になる)。
const HIDDEN_KEYWORDS_KEY = "mokou-timeline:hiddenKeywords";
const DEFAULT_KEYWORDS = ["w", "^あ$"];
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
function loadHiddenKeywords() {
  try {
    const raw = localStorage.getItem(HIDDEN_KEYWORDS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch (e) {
    return new Set();
  }
}
function saveHiddenKeywords(set) {
  try {
    localStorage.setItem(HIDDEN_KEYWORDS_KEY, JSON.stringify([...set]));
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
let hiddenKeywords = loadHiddenKeywords();

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
// コメントと配信長を持つ (モーダルを閉じたら closeDetail が null に戻す)。
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
  closeBtn.addEventListener("click", closeDetail);

  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "graph-modal-body";

  // カードに出ている情報 (日時・種別・再生数・コメント数など) を並べる行
  const infoBox = document.createElement("div");
  infoBox.className = "card-meta detail-info";
  body.appendChild(infoBox);

  // タグ (YouTube の動画/配信のみ。無ければ非表示)
  const tagsBox = document.createElement("div");
  tagsBox.className = "detail-tags";
  tagsBox.hidden = true;
  const tagsLabel = document.createElement("div");
  tagsLabel.className = "detail-section-title";
  tagsLabel.textContent = "🏷 タグ";
  const tagsList = document.createElement("div");
  tagsList.className = "detail-tags-list";
  tagsBox.appendChild(tagsLabel);
  tagsBox.appendChild(tagsList);
  body.appendChild(tagsBox);

  // 概要欄 (YouTube の動画 (type:"video") のみ。配信・概要欄が無い場合は非表示)
  const descriptionBox = document.createElement("div");
  descriptionBox.className = "detail-description-box";
  descriptionBox.hidden = true;
  const descriptionLabel = document.createElement("div");
  descriptionLabel.className = "detail-section-title";
  descriptionLabel.textContent = "📝 概要欄";
  const descriptionText = document.createElement("div");
  descriptionText.className = "detail-description";
  descriptionBox.appendChild(descriptionLabel);
  descriptionBox.appendChild(descriptionText);
  body.appendChild(descriptionBox);

  // コメント流量グラフ (配信のみ。動画は非表示)
  const graphSection = document.createElement("div");
  graphSection.className = "detail-graph";
  graphSection.hidden = true;

  const graphLabel = document.createElement("div");
  graphLabel.className = "detail-section-title";
  graphLabel.textContent = "📊 コメント流量";
  graphSection.appendChild(graphLabel);

  const keywordEditor = buildKeywordEditor();
  graphSection.appendChild(keywordEditor.details);

  const status = document.createElement("div");
  status.className = "graph-modal-status";

  const chartWrap = document.createElement("div");
  chartWrap.className = "graph-modal-chart";
  chartWrap.hidden = true;
  const canvas = document.createElement("canvas");
  chartWrap.appendChild(canvas);

  graphSection.appendChild(status);
  graphSection.appendChild(chartWrap);
  body.appendChild(graphSection);

  const footer = document.createElement("div");
  footer.className = "graph-modal-footer";
  const link = document.createElement("a");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "graph-modal-link";
  footer.appendChild(link);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !backdrop.hidden) closeDetail();
  });

  return {
    backdrop, panel, title, infoBox, tagsBox, tagsList,
    descriptionBox, descriptionText,
    graphSection, status, chartWrap, canvas, link, keywordEditor,
  };
}

// ---- 情報行・タグの描画 ----
function renderInfoBox(infoBox, item) {
  infoBox.textContent = "";

  const date = document.createElement("span");
  date.className = "card-date";
  date.textContent = item.isLive ? "配信中" : fmtDate(item.start);
  infoBox.appendChild(date);

  const typeTag = document.createElement("span");
  typeTag.className = "tag " + item.type;
  typeTag.textContent = item.type === "stream" ? "配信" : "動画";
  infoBox.appendChild(typeTag);

  if (item.membersOnly) {
    const m = document.createElement("span");
    m.className = "tag members";
    m.textContent = "メン限";
    infoBox.appendChild(m);
  }

  if (item.views != null) {
    const v = document.createElement("span");
    v.className = "views";
    v.textContent = fmtCount(item.views);
    v.title = `${item.views.toLocaleString()}回視聴`;
    infoBox.appendChild(v);
  }

  if (item.likes != null) {
    const l = document.createElement("span");
    l.className = "likes";
    l.textContent = fmtLikeCount(item.likes);
    l.title = `${item.likes.toLocaleString()}件の高評価`;
    infoBox.appendChild(l);
  }

  if (item.comments != null) {
    const rate = commentRate(item);
    const c = document.createElement("span");
    c.textContent = rate != null
      ? `💬 ${fmtCount(item.comments)}件（1時間あたり約${fmtCount(Math.round(rate))}）`
      : `💬 ${fmtCount(item.comments)}件`;
    infoBox.appendChild(c);
  }
}

function renderTagsBox(tagsBox, tagsList, item) {
  tagsList.textContent = "";
  const tags = item.tags || [];
  tagsBox.hidden = tags.length === 0;
  for (const t of tags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip";
    // 既にそのタグで絞り込み中なら見た目で示す (selectTag/state.tags は app.js 側)
    if (state.tags.some((st) => normalizeText(st) === normalizeText(t))) {
      chip.classList.add("active");
    }
    chip.textContent = t; // textContent で XSS 回避
    chip.title = `タグ「${t}」で絞り込む`;
    chip.addEventListener("click", () => {
      selectTag(t);
      closeDetail();
    });
    tagsList.appendChild(chip);
  }
}

// 概要欄は動画 (type:"video") のみ表示。配信は含めない (①ユーザーの要望、
// ②配信アーカイブの概要欄はチャンネル共通の定型文であることが多く情報量が薄いため)。
function renderDescriptionBox(descriptionBox, descriptionText, item) {
  const show = item.type === "video" && !!item.description;
  descriptionBox.hidden = !show;
  descriptionText.textContent = show ? item.description : ""; // textContent で XSS 回避
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
    "正規表現でキーワードを指定できます（例: w、^あ$）。1分ごとの出現回数を数え、" +
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
    // キーワード自体を既定に戻すので、オン/オフも一緒に既定(すべてオン)へ戻す
    hiddenKeywords.clear();
    saveHiddenKeywords(hiddenKeywords);
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
    input.placeholder = "正規表現 (例: w)";
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
      // 消したキーワードのオン/オフ記録も一緒に消す (localStorage に残り続けないように)
      if (hiddenKeywords.delete(word)) saveHiddenKeywords(hiddenKeywords);
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

function closeDetail() {
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
          hidden: hiddenKeywords.has(word),
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
            const nowVisible = !ch.isDatasetVisible(di);
            ch.setDatasetVisibility(di, nowVisible);
            ch.update();
            // di===0 は「全コメント」の合計線なので対象外。キーワード (di>=1) だけ
            // オン/オフを保存し、次にこの配信・他の配信を開いたときも引き継ぐ。
            if (di > 0) {
              const word = keywords[di - 1];
              if (nowVisible) hiddenKeywords.delete(word);
              else hiddenKeywords.add(word);
              saveHiddenKeywords(hiddenKeywords);
            }
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

async function openItemDetail(item) {
  if (!modalEls) modalEls = buildModal();
  const {
    backdrop, title, infoBox, tagsBox, tagsList, descriptionBox, descriptionText,
    graphSection, status, chartWrap, canvas, link,
  } = modalEls;
  const seq = ++requestSeq;

  if (currentChart) {
    try {
      currentChart.destroy();
    } catch (e) {}
    currentChart = null;
  }
  lastFiltered = null;
  lastOffsetSec = null;
  lastItem = null;

  title.textContent = item.title;
  link.textContent = `${platformLabel(item.platform)}で開く`;
  link.href = item.url;
  renderInfoBox(infoBox, item);
  renderTagsBox(tagsBox, tagsList, item);
  renderDescriptionBox(descriptionBox, descriptionText, item);
  backdrop.hidden = false;

  // コメント流量グラフは配信のみ (動画には出さない)
  const isStream = item.type === "stream";
  graphSection.hidden = !isStream;
  if (!isStream) return;

  chartWrap.hidden = true;
  status.hidden = false;
  status.textContent = "読み込み中…";

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
    console.error("[Detail]", e);
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

window.openItemDetail = openItemDetail;
