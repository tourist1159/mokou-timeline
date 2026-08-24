"use strict";

/* ===== 設定（リポジトリ名/アカウントを変えたらここだけ直す） ===== */
const CONFIG = {
  sources: {
    youtube: "https://tourist1159.github.io/youtube-comment-fetcher/youtube_archives.json",
    kick: "https://tourist1159.github.io/kick-comment-fetcher/kick_archives.json",
    twitch: "https://tourist1159.github.io/twitch-archive-fetcher/twitch_archives.json",
    // 同一オリジン (このサイト自身が1分間隔で更新・公開する)
    liveStatus: "live_status.json",
  },
  // チャンネル表示名（フィルタチップ・カードのバッジ用）
  channelLabels: {
    mokouliszt: "もこう",
    mokoustream: "mokoustream",
    mokoutoaruotoko: "Kick本配信",
    mokouliszt1: "Twitch配信",
  },
  // チャンネルフィルタに並べる順
  channelOrder: ["mokouliszt", "mokoustream", "mokoutoaruotoko", "mokouliszt1"],
};

/* ===== 状態 ===== */
let ALL = [];
let LIVE = []; // 現在ライブ配信中の一覧 (live_status.json)
// view/timeline/newMarker は「表示設定」(localStorage) で永続化する。URLクエリには含めない。
const state = {
  platform: "all", channel: "all", type: "all", order: "desc", q: "",
  view: "grid", timeline: true, newMarker: true,
};

/* ===== 表示設定 (localStorage) ===== */
const SETTINGS_KEY = "mokou-timeline:settings";
const DEFAULT_SETTINGS = { view: "grid", timeline: true, newMarker: true };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ view: state.view, timeline: state.timeline, newMarker: state.newMarker })
    );
  } catch (e) {
    // プライベートブラウジング等で localStorage が使えない場合は諦める(機能はセッション内のみ動作)
  }
}

/* ===== 新着判定 (localStorage) =====
 * 前回訪問時に見えていたアイテムのIDを保存しておき、今回無かったものを「新着」とする。
 * 初回訪問(保存が無い)は比較対象が無いので全件「新着でない」扱いにする。 */
const SEEN_KEY = "mokou-timeline:seenIds";

function itemId(item) {
  return `${item.platform}:${item.videoId}`;
}
function loadSeenIds() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch (e) {
    return null;
  }
}
function markNewItems() {
  const seen = loadSeenIds();
  for (const item of ALL) item.isNew = seen ? !seen.has(itemId(item)) : false;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ALL.map(itemId)));
  } catch (e) {
    // 保存できなくても表示自体は継続する
  }
}

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
// JST基準の日付キー "YYYY-MM-DD"。訪問者のブラウザのタイムゾーンに関わらず日本時間で揃える。
function jstDateKey(d) {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
function timelineLabel(d) {
  const key = jstDateKey(d);
  const now = new Date();
  if (key === jstDateKey(now)) return "今日";
  if (key === jstDateKey(new Date(now.getTime() - 86400000))) return "昨日";
  const [, m, day] = key.split("-").map(Number);
  // JSTの00:00固定でDateを作り、ブラウザのローカルタイムゾーンによる曜日ズレを防ぐ
  const wd = WEEKDAY_JA[new Date(`${key}T00:00:00+09:00`).getDay()];
  return `${m}/${day}(${wd})`;
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
function platformLabel(p) {
  return p === "youtube" ? "YouTube" : p === "kick" ? "Kick" : "Twitch";
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
    commentsKey: v.video_id, // comments_github/<commentsKey>_comments.json
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
    // 削除済み動画は fetcher がサムネを取得できないため null → プレースホルダー表示
    thumbnail: v.thumbnail || null,
    // Kick は一定期間で古いVODを削除する。available:false は動画がもう存在しない。
    available: v.available !== false,
    // comments_github のファイル名はアーカイブ "id"（内部動画IDの video_id ではない）
    commentsKey: v.id,
  }));
}
function normalizeTwitch(arr) {
  return arr.map((v) => ({
    platform: "twitch",
    channel: "mokouliszt1",
    type: "stream", // Twitch アーカイブ(type=archive)は全て過去配信
    title: v.title || "",
    url: v.url || `https://www.twitch.tv/videos/${v.id}`,
    videoId: v.id,
    start: new Date(v.start_time),
    durationSec: v.duration || 0,
    lengthStr: "",
    comments: null, // コメント流量グラフは未対応 (VOD一覧表示のみ)
    // Twitch も一定期間でVODを削除する。削除済みはサムネも失われるため null → プレースホルダー
    thumbnail: v.thumbnail || null,
    available: v.available !== false,
    commentsKey: null,
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
    fetch(CONFIG.sources.twitch, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error("Twitch JSON HTTP " + r.status);
      return r.json();
    }),
    // ライブ状態は無くても致命的でない (1分間隔更新の付加情報) ので、
    // 失敗しても "failed" 扱いにはせず静かに空配列のままにする。
    fetch(liveStatusUrl(), { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error("live_status.json HTTP " + r.status);
      return r.json();
    }),
  ]);

  const items = [];
  const failed = [];
  if (results[0].status === "fulfilled") items.push(...normalizeYouTube(results[0].value));
  else failed.push("YouTube");
  if (results[1].status === "fulfilled") items.push(...normalizeKick(results[1].value));
  else failed.push("Kick");
  if (results[2].status === "fulfilled") items.push(...normalizeTwitch(results[2].value));
  else failed.push("Twitch");
  LIVE = results[3].status === "fulfilled" ? (results[3].value.live || []) : [];

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
      // YouTube のみ別解像度で再試行 (Kick の videoId は数値IDなので流用できない)
      if (tries === 0 && item.platform === "youtube" && item.videoId) {
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
  badge.textContent = platformLabel(item.platform);
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

  // コメントデータがある配信のみ、流量グラフを開くボタンを表示（説明部分の右側）
  if (item.comments != null && item.comments > 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "graph-btn";
    btn.title = "コメント流量グラフを見る";
    btn.setAttribute("aria-label", "コメント流量グラフを見る");
    btn.textContent = "📊";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.openCommentGraph(item);
    });
    meta.appendChild(btn);
  }

  body.appendChild(meta);
  card.appendChild(body);
  return card;
}

/* ===== ライブ配信中バナー ===== */
function makeLiveCard(item) {
  const card = document.createElement("a");
  card.className = "live-card";
  card.href = item.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";

  const thumb = document.createElement("div");
  thumb.className = "live-thumb";
  if (item.thumbnail) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = item.thumbnail;
    img.onerror = () => img.remove();
    thumb.appendChild(img);
  }
  const dot = document.createElement("span");
  dot.className = "live-dot";
  dot.textContent = "LIVE";
  thumb.appendChild(dot);
  card.appendChild(thumb);

  const info = document.createElement("div");
  info.className = "live-info";
  const title = document.createElement("div");
  title.className = "live-title";
  title.textContent = item.title;
  info.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "live-meta";
  const platformSpan = document.createElement("span");
  platformSpan.className = "badge-platform " + item.platform;
  platformSpan.textContent = platformLabel(item.platform);
  meta.appendChild(platformSpan);
  const chSpan = document.createElement("span");
  chSpan.textContent = channelLabel(item.channel);
  meta.appendChild(chSpan);
  if (typeof item.viewers === "number") {
    const v = document.createElement("span");
    v.textContent = `👁 ${item.viewers.toLocaleString()}`;
    meta.appendChild(v);
  }
  info.appendChild(meta);
  card.appendChild(info);

  return card;
}

function renderLiveBanner() {
  const el = document.getElementById("live-banner");
  el.textContent = "";
  if (!LIVE.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const frag = document.createDocumentFragment();
  for (const item of LIVE) frag.appendChild(makeLiveCard(item));
  el.appendChild(frag);
}

// GitHub Pages は CDN(Fastly)側でも数分キャッシュされるため、cache:"no-cache" だけでは
// 古い live_status.json を掴まされることがある。クエリを毎回変えてキャッシュキーをずらす。
function liveStatusUrl() {
  return `${CONFIG.sources.liveStatus}?t=${Date.now()}`;
}

async function refreshLiveStatus() {
  try {
    const r = await fetch(liveStatusUrl(), { cache: "no-cache" });
    if (!r.ok) return;
    const data = await r.json();
    LIVE = data.live || [];
    renderLiveBanner();
  } catch (e) {
    // 次回のポーリングで回復するため、ここでは何もしない
  }
}

function makeNewMarker() {
  const el = document.createElement("div");
  el.className = "new-marker";
  el.innerHTML = '<span class="new-marker-line"></span><span>新着</span><span class="new-marker-line"></span>';
  return el;
}

// 現在の並び順(state.order)における「新着アイテムの並び」から抜けた直後のインデックスを返す。
// 新着は日付順に並んだ結果、常にどちらかの端に固まる想定 (降順なら先頭、昇順なら末尾)。
// 端から連続していない場合や、全件新着/新着0件の場合は表示しない(-1)。
function computeNewBoundary(list) {
  if (!state.newMarker || !list.length) return -1;
  if (state.order === "desc") {
    let i = 0;
    while (i < list.length && list[i].isNew) i++;
    return i > 0 && i < list.length ? i : -1;
  }
  let i = list.length;
  while (i > 0 && list[i - 1].isNew) i--;
  return i > 0 && i < list.length ? i : -1;
}

function groupByDate(list) {
  const groups = [];
  let current = null;
  for (const item of list) {
    const key = jstDateKey(item.start);
    if (!current || current.key !== key) {
      current = { key, label: timelineLabel(item.start), items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

function renderFlat(list, boundary, frag) {
  list.forEach((item, i) => {
    if (i === boundary) frag.appendChild(makeNewMarker());
    frag.appendChild(makeCard(item));
  });
}

function renderWithTimeline(list, boundary, frag) {
  let i = 0;
  for (const group of groupByDate(list)) {
    const section = document.createElement("section");
    section.className = "date-group";

    const label = document.createElement("div");
    label.className = "date-label";
    label.textContent = group.label;
    section.appendChild(label);

    const items = document.createElement("div");
    items.className = "date-items " + (state.view === "list" ? "view-list" : "view-grid");
    for (const item of group.items) {
      if (i === boundary) items.appendChild(makeNewMarker());
      items.appendChild(makeCard(item));
      i++;
    }
    section.appendChild(items);
    frag.appendChild(section);
  }
}

function render() {
  const list = applyFilters();
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  // with-timeline時は #grid 自身ではなく内側の .date-items が grid/list を担うので、
  // view-list クラスは timeline OFF の時だけ付ける (CSSの優先順位の衝突を避けるため)。
  grid.classList.toggle("view-list", state.view === "list" && !state.timeline);
  grid.classList.toggle("with-timeline", state.timeline);
  grid.textContent = "";

  const boundary = computeNewBoundary(list);
  const frag = document.createDocumentFragment();
  if (state.timeline) {
    renderWithTimeline(list, boundary, frag);
  } else {
    renderFlat(list, boundary, frag);
  }
  grid.appendChild(frag);

  empty.hidden = list.length > 0;
  updateStats(list.length);
  syncPrimaryOffset();
}

// モバイルでは .controls-primary が position:fixed (デスクトップでは display:contents
// で本来ボックスを持たないため offsetHeight は常に0、つまりここは実質ノーオペになる)。
// フローから外れた分、body 全体を高さぶん押し下げる (site-header や controls-secondary が
// 固定バーの下に隠れないように)。
function syncPrimaryOffset() {
  const primary = document.querySelector(".controls-primary");
  document.body.style.paddingTop = primary.offsetHeight + "px";
}

function updateStats(shown) {
  const yt = ALL.filter((x) => x.platform === "youtube").length;
  const kk = ALL.filter((x) => x.platform === "kick").length;
  const tw = ALL.filter((x) => x.platform === "twitch").length;
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
  add(`YouTube <b>${yt}</b>・Kick <b>${kk}</b>・Twitch <b>${tw}</b>`);
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
  for (const k of ["platform", "channel", "type", "order", "q"]) {
    if (p.has(k)) state[k] = p.get(k);
  }
}
function writeQuery() {
  const p = new URLSearchParams();
  for (const k of ["platform", "channel", "type"]) if (state[k] !== "all") p.set(k, state[k]);
  if (state.order !== "desc") p.set("order", state.order);
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

/* ===== 表示設定パネルの見た目を状態に同期 ===== */
function syncSettingsUI() {
  document.getElementById("toggle-timeline").checked = state.timeline;
  document.getElementById("toggle-newmarker").checked = state.newMarker;
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
      saveSettings();
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

  document.getElementById("toggle-timeline").addEventListener("change", (e) => {
    state.timeline = e.target.checked;
    saveSettings();
    render();
  });
  document.getElementById("toggle-newmarker").addEventListener("change", (e) => {
    state.newMarker = e.target.checked;
    saveSettings();
    render();
  });
}

/* ===== 表示設定パネルの開閉 ===== */
function wireSettingsPanel() {
  const btn = document.getElementById("settings-btn");
  const panel = document.getElementById("settings-panel");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    btn.setAttribute("aria-expanded", String(willOpen));
    // モバイルは position:fixed (ビューポート基準) なので、ボタンの実際の位置から
    // 毎回 top を計算する。.settings-group がその行の左寄りに折り返されて right:0
    // 基準だと画面外にはみ出すことがあるため (CSS側は left/right をビューポート基準で
    // 固定して幅を確保済み)。デスクトップは position:absolute のままCSSのcalc(100% + 8px)
    // に任せるので、ここでは触らない。
    if (willOpen && window.matchMedia("(max-width: 600px)").matches) {
      panel.style.top = btn.getBoundingClientRect().bottom + 8 + "px";
    }
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    if (!panel.hidden) {
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
  });
}

/* ===== 起動 ===== */
async function main() {
  // データ取得中の「読み込み中…」表示の間も固定バーでヘッダーが隠れないよう、先に計算しておく。
  syncPrimaryOffset();

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

  Object.assign(state, loadSettings());
  markNewItems();

  buildChannelChips();
  readQuery();
  syncChipUI();
  syncSettingsUI();
  wireEvents();
  wireSettingsPanel();
  renderLiveBanner();
  render();

  if (failed.length) {
    const n = document.createElement("div");
    n.className = "notice";
    n.textContent = `⚠️ ${failed.join(" / ")} のデータを取得できませんでした（他は表示中）。`;
    document.querySelector(".controls").insertAdjacentElement("afterend", n);
  }

  const foot = document.getElementById("footer-note");
  foot.textContent =
    "データ源: youtube-comment-fetcher / kick-comment-fetcher / twitch-archive-fetcher（GitHub Pages）。読み込み時に最新を取得します。";

  // ライブ配信中の状態は定期的にポーリングして更新する (軽量な live_status.json のみ再取得)。
  // サーバ側(Actions)が1分おきに更新するので、こちらは30秒間隔で追従する。
  setInterval(refreshLiveStatus, 30000);

  // 画面回転・リサイズで .controls-primary の折り返し行数が変わることがあるため、
  // その都度オフセットを再計算する (fixed化した高さぶんの余白の再調整)。
  window.addEventListener("resize", syncPrimaryOffset);
}

main();
