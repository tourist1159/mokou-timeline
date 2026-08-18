"use strict";

/*
 * コメント流量グラフ（モーダル表示）
 * カードの📊ボタンから開き、該当配信のコメントJSONを取得して1分バケットのグラフを描く。
 * 集計ロジックは拡張機能 sortcomments/commentgraph.js・kick-extension/js/commentchart.js の
 * 移植（重複除去→1分バケット→キーワード別カウント）。埋め込みプレイヤーは持たないため
 * currentTime連動やクリックシークは無い。
 */

const GRAPH_KEYWORDS = ["草|w", "8{3,}", "^あ+$"];
const GRAPH_KEYWORD_COLORS = ["red", "orange", "cyan"];

const COMMENTS_BASE = {
  youtube: "https://tourist1159.github.io/youtube-comment-fetcher/comments_github/",
  kick: "https://tourist1159.github.io/kick-comment-fetcher/comments_github/",
};

let modalEls = null; // 初回オープン時に生成して使い回す
let currentChart = null;
let requestSeq = 0; // 連打時、古いレスポンスの描画を防ぐ

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

  return { backdrop, panel, title, status, chartWrap, canvas, link };
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
function bucketComments(filtered, lastOffset) {
  const minutes = Math.max(1, Math.floor(lastOffset / 60) + 1);
  const totalCounts = new Array(minutes).fill(0);
  const keywordCounts = {};
  for (const word of GRAPH_KEYWORDS) keywordCounts[word] = new Array(minutes).fill(0);

  for (const c of filtered) {
    const diffMin = Math.floor(c.offsetSec / 60);
    if (diffMin < 0 || diffMin >= minutes) continue;
    totalCounts[diffMin]++;
    const text = c.text || "";
    for (const word of GRAPH_KEYWORDS) {
      try {
        const matches = text.match(new RegExp(word, "gi"));
        if (matches && matches.length < 10) keywordCounts[word][diffMin] += matches.length;
      } catch (e) {
        /* 無効な正規表現は無視 */
      }
    }
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

function renderChart(canvas, agg, item, link) {
  const ctx = canvas.getContext("2d");
  return new window.Chart(ctx, {
    type: "line",
    data: {
      labels: agg.labels,
      datasets: [
        {
          label: "全コメント",
          data: agg.totalCounts,
          borderColor: "lime",
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          yAxisID: "yTotal",
        },
        ...GRAPH_KEYWORDS.map((word, i) => ({
          label: word,
          data: agg.keywordCounts[word],
          borderColor: GRAPH_KEYWORD_COLORS[i % GRAPH_KEYWORD_COLORS.length],
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
          labels: { color: "#ccc", boxWidth: 12, font: { size: 11 } },
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
    const agg = bucketComments(filtered, lastOffset);

    status.hidden = true;
    chartWrap.hidden = false;
    currentChart = renderChart(canvas, agg, item, link);
  } catch (e) {
    if (seq !== requestSeq) return;
    console.error("[CommentGraph]", e);
    status.textContent = "コメントデータの取得に失敗しました。";
  }
}

window.openCommentGraph = openCommentGraph;
