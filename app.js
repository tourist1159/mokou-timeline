"use strict";

/* ===== 設定（リポジトリ名/アカウントを変えたらここだけ直す） ===== */
const CONFIG = {
  sources: {
    youtube: "https://tourist1159.github.io/youtube-comment-fetcher/youtube_archives.json",
    kick: "https://tourist1159.github.io/kick-comment-fetcher/kick_archives.json",
  },
  // チャンネル表示名（フィルタチップ・カードのバッジ用）
  channelLabels: {
    mokouliszt: "もこう",
    mokoustream: "mokoustream",
    mokoutoaruotoko: "Kick本配信",
  },
  // チャンネルフィルタに並べる順
  channelOrder: ["mokouliszt", "mokoustream", "mokoutoaruotoko"],
};

/* ===== 状態 ===== */
let ALL = [];
const state = { platform: "all", channel: "all", type: "all", order: "desc", q: "", view: "grid" };

/* ===== ユーティリティ ===== */
const dateFmt = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo",
});
function fmtDate(d) {
  return d && !isNaN(d) ? dateFmt.format(d) : "";
}
function fmtDateOnly(d) {
  return d && !isNaN(d) ? d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }) : "";
}
function fmtDuration(sec, lengthStr) {
  if (lengthStr) return lengthStr;
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
function normalizeText(t) {
  return (t || "").toLowerCase().replace(/[！!？?\s]/g, "").normalize("NFKC");
}
function channelLabel(ch) {
  return CONFIG.channelLabels[ch] || ch;
}

/* ===== 正規化 ===== */
function normalizeYouTube(arr) {
  return arr.map((v) => ({
    platform: "youtube",
    channel: v.channel || "youtube",
    type: v.type || "stream",
    title: v.title || "",
    url: v.url || `https://www.youtube.com/watch?v=${v.video_id}`,
    videoId: v.video_id,
    start: new Date(v.start_time),
    durationSec: v.duration || 0,
    lengthStr: v.video_length || "",
    comments: typeof v.number_of_comments === "number" ? v.number_of_comments : null,
    thumbnail: v.video_id ? `https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg` : null,
    available: v.available !== false, // フラグ未設定は視聴可能とみなす
  }));
}
function normalizeKick(arr) {
  return arr.map((v) => ({
    platform: "kick",
    channel: "mokoutoaruotoko",
    type: "stream", // Kick アーカイブは全て配信
    title: v.title || "",
    url: v.url || "",
    videoId: v.video_id,
    start: new Date(v.start_time),
    durationSec: Math.round((v.duration || 0) / 1000), // ms → 秒
    lengthStr: v.video_length || "",
    comments: typeof v.number_of_comments === "number" ? v.number_of_comments : null,
    thumbnail: null, // Kick はサムネ未保存 → プレースホルダー
    // Kick は一定期間で古いVODを削除する。available:false は動画がもう存在しない。
    available: v.available !== false,
  }));
}

/* ===== 取得 ===== */
async function loadData() {
  const results = await Promise.allSettled([
    fetch(CONFIG.sources.youtube, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error("YouTube JSON HTTP " + r.status);
      return r.json();
    }),
    fetch(CONFIG.sources.kick, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error("Kick JSON HTTP " + r.status);
      return r.json();
    }),
  ]);

  const items = [];
  const failed = [];
  if (results[0].status === "fulfilled") items.push(...normalizeYouTube(results[0].value));
  else failed.push("YouTube");
  if (results[1].status === "fulfilled") items.push(...normalizeKick(results[1].value));
  else failed.push("Kick");

  // 不正エントリ（日時なし等）を除外
  ALL = items.filter((x) => x.start && !isNaN(x.start) && x.title && x.url);
  return failed;
}

/* ===== フィルタ & 描画 ===== */
function applyFilters() {
  const q = normalizeText(state.q);
  let list = ALL.filter((x) => {
    if (state.platform !== "all" && x.platform !== state.platform) return false;
    if (state.channel !== "all" && x.channel !== state.channel) return false;
    if (state.type !== "all" && x.type !== state.type) return false;
    if (q && !normalizeText(x.title).includes(q)) return false;
    return true;
  });
  list.sort((a, b) => (state.order === "desc" ? b.start - a.start : a.start - b.start));
  return list;
}

function makeThumb(item) {
  const wrap = document.createElement("div");
  wrap.className = "thumb";

  if (item.thumbnail) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = item.thumbnail;
    img.dataset.tries = "0";
    img.onerror = () => {
      const tries = Number(img.dataset.tries);
      if (tries === 0 && item.videoId) {
        img.dataset.tries = "1";
        img.src = `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
      } else {
        wrap.replaceChild(makePlaceholder(item), img);
      }
    };
    wrap.appendChild(img);
  } else {
    wrap.appendChild(makePlaceholder(item));
  }

  const badge = document.createElement("span");
  badge.className = "badge-platform " + item.platform;
  badge.textContent = item.platform === "youtube" ? "YouTube" : "Kick";
  wrap.appendChild(badge);

  const dur = document.createElement("span");
  dur.className = "duration";
  dur.textContent = fmtDuration(item.durationSec, item.lengthStr);
  wrap.appendChild(dur);

  return wrap;
}

function makePlaceholder(item) {
  const ph = document.createElement("div");
  ph.className = "thumb-ph";
  const ch = (item.title || "").trim().charAt(0) || "K";
  ph.textContent = ch;
  return ph;
}

function makeCard(item) {
  // 削除済みの動画はリンクにしない (クリックしても404になるだけのため)
  const card = document.createElement(item.available ? "a" : "div");
  card.className = item.available ? "card" : "card unavailable";
  if (item.available) {
    card.href = item.url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
  } else {
    card.title = "この動画は配信元で削除されています";
  }

  card.appendChild(makeThumb(item));

  const body = document.createElement("div");
  body.className = "card-body";

  const title = document.createElement("h3");
  title.className = "card-title";
  title.textContent = item.title; // textContent で XSS 回避
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "card-meta";

  const date = document.createElement("span");
  date.className = "card-date";
  date.textContent = fmtDate(item.start);
  meta.appendChild(date);

  const chTag = document.createElement("span");
  chTag.className = "tag";
  chTag.textContent = channelLabel(item.channel);
  meta.appendChild(chTag);

  const typeTag = document.createElement("span");
  typeTag.className = "tag " + item.type;
  typeTag.textContent = item.type === "stream" ? "配信" : "動画";
  meta.appendChild(typeTag);

  if (item.comments != null) {
    const c = document.createElement("span");
    c.className = "comments";
    c.textContent = item.comments.toLocaleString();
    meta.appendChild(c);
  }

  if (!item.available) {
    const del = document.createElement("span");
    del.className = "tag deleted";
    del.textContent = "削除済み";
    meta.appendChild(del);
  }

  body.appendChild(meta);
  card.appendChild(body);
  return card;
}

function render() {
  const list = applyFilters();
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  grid.classList.toggle("view-list", state.view === "list");
  grid.textContent = "";

  const frag = document.createDocumentFragment();
  for (const item of list) frag.appendChild(makeCard(item));
  grid.appendChild(frag);

  empty.hidden = list.length > 0;
  updateStats(list.length);
}

function updateStats(shown) {
  const yt = ALL.filter((x) => x.platform === "youtube").length;
  const kk = ALL.filter((x) => x.platform === "kick").length;
  const streams = ALL.filter((x) => x.type === "stream").length;
  const videos = ALL.filter((x) => x.type === "video").length;
  const dates = ALL.map((x) => x.start).sort((a, b) => a - b);
  const range = dates.length ? `${fmtDateOnly(dates[0])} 〜 ${fmtDateOnly(dates[dates.length - 1])}` : "";
  const el = document.getElementById("stats");
  el.innerHTML = "";
  const add = (html) => {
    const s = document.createElement("span");
    s.innerHTML = html;
    el.appendChild(s);
  };
  const gone = ALL.filter((x) => !x.available).length;
  add(`表示 <b>${shown}</b> / 全 <b>${ALL.length}</b> 件`);
  add(`YouTube <b>${yt}</b>・Kick <b>${kk}</b>`);
  add(`配信 <b>${streams}</b>・動画 <b>${videos}</b>`);
  if (gone) add(`視聴可 <b>${ALL.length - gone}</b>・削除済み <b>${gone}</b>`);
  if (range) add(`期間 <b>${range}</b>`);
}

/* ===== チャンネルフィルタのチップを動的生成 ===== */
function buildChannelChips() {
  const present = new Set(ALL.map((x) => x.channel));
  const group = document.getElementById("filter-channel");
  for (const ch of CONFIG.channelOrder) {
    if (!present.has(ch)) continue;
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.dataset.value = ch;
    btn.textContent = channelLabel(ch);
    group.appendChild(btn);
  }
}

/* ===== URL クエリ同期 ===== */
function readQuery() {
  const p = new URLSearchParams(location.search);
  for (const k of ["platform", "channel", "type", "order", "q", "view"]) {
    if (p.has(k)) state[k] = p.get(k);
  }
}
function writeQuery() {
  const p = new URLSearchParams();
  for (const k of ["platform", "channel", "type"]) if (state[k] !== "all") p.set(k, state[k]);
  if (state.order !== "desc") p.set("order", state.order);
  if (state.view !== "grid") p.set("view", state.view);
  if (state.q) p.set("q", state.q);
  const qs = p.toString();
  history.replaceState(null, "", qs ? "?" + qs : location.pathname);
}

/* ===== チップの見た目を状態に同期 ===== */
function syncChipUI() {
  document.querySelectorAll(".control-group[data-key]").forEach((group) => {
    const key = group.dataset.key;
    group.querySelectorAll(".chip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.value === state[key]);
    });
  });
  const st = document.getElementById("sort-toggle");
  st.dataset.order = state.order;
  st.textContent = state.order === "desc" ? "新しい順" : "古い順";
  st.classList.add("active");
  document.getElementById("search").value = state.q;
}

/* ===== イベント ===== */
function wireEvents() {
  document.querySelectorAll(".control-group[data-key]").forEach((group) => {
    const key = group.dataset.key;
    group.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      state[key] = chip.dataset.value;
      syncChipUI();
      writeQuery();
      render();
    });
  });

  const st = document.getElementById("sort-toggle");
  st.addEventListener("click", () => {
    state.order = state.order === "desc" ? "asc" : "desc";
    syncChipUI();
    writeQuery();
    render();
  });

  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    state.q = search.value;
    writeQuery();
    render();
  });
}

/* ===== 起動 ===== */
async function main() {
  const grid = document.getElementById("grid");
  grid.innerHTML = '<div class="loading">読み込み中…</div>';

  let failed = [];
  try {
    failed = await loadData();
  } catch (e) {
    grid.innerHTML = '<div class="loading">データの取得に失敗しました。</div>';
    console.error(e);
    return;
  }

  buildChannelChips();
  readQuery();
  syncChipUI();
  wireEvents();
  render();

  if (failed.length) {
    const n = document.createElement("div");
    n.className = "notice";
    n.textContent = `⚠️ ${failed.join(" / ")} のデータを取得できませんでした（他は表示中）。`;
    document.querySelector(".controls").insertAdjacentElement("afterend", n);
  }

  const foot = document.getElementById("footer-note");
  foot.textContent =
    "データ源: youtube-comment-fetcher / kick-comment-fetcher（GitHub Pages）。読み込み時に最新を取得します。";
}

main();
