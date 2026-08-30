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
  // チャンネル表示名（ライブバナー等で使用。Kick/Twitchは単一チャンネルのため
  // フィルタチップは出さないが、ラベル自体は他の表示箇所のために残す）
  channelLabels: {
    mokouliszt: "とある漢",
    mokoustream: "もこうの実況",
    mokoutoaruotoko: "Kick本配信",
    mokouliszt1: "Twitch配信",
  },
  // チャンネルフィルタに並べる順。Kick/Twitchは単一チャンネルなので配信元フィルタと
  // 重複するため出さない (YouTubeの2チャンネルのみ)
  channelOrder: ["mokoustream", "mokouliszt"],
};

/* ===== 状態 ===== */
let ALL = [];
let LIVE = []; // 現在ライブ配信中の一覧 (live_status.json)
// view/timeline/newMarker/showComments/theme/onlyAvailable は「表示設定」(localStorage) で永続化する。URLクエリには含めない。
const state = {
  platform: "all", channel: "all", type: "all", order: "desc", q: "",
  view: "grid", timeline: true, newMarker: true, showComments: true, theme: "system",
  onlyAvailable: false,
};

/* ===== 表示設定 (localStorage) ===== */
const SETTINGS_KEY = "mokou-timeline:settings";
const DEFAULT_SETTINGS = {
  view: "grid", timeline: true, newMarker: true, showComments: true, theme: "system",
  onlyAvailable: false,
};

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
      JSON.stringify({
        view: state.view,
        timeline: state.timeline,
        newMarker: state.newMarker,
        showComments: state.showComments,
        theme: state.theme,
        onlyAvailable: state.onlyAvailable,
      })
    );
  } catch (e) {
    // プライベートブラウジング等で localStorage が使えない場合は諦める(機能はセッション内のみ動作)
  }
}

/* ===== カラーテーマ =====
 * state.theme: "system"(既定, prefers-color-schemeに追従) / "light" / "dark"。
 * <html data-theme> に反映し、実際の色は style.css 側の CSS変数で切り替える。
 * index.html 冒頭のインラインスクリプトが、CSS読み込み前に同じロジックで先に一度
 * 適用しているため(チラつき防止)、ここでの再適用は実質的に整合性の再確認。 */
function applyTheme() {
  if (state.theme === "light" || state.theme === "dark") {
    document.documentElement.setAttribute("data-theme", state.theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}
// 実際に見えているテーマ ("system" のときはOS設定を反映)。commentgraph.js からも使う。
function resolvedTheme() {
  if (state.theme === "light" || state.theme === "dark") return state.theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
// JST基準の日付キー "YYYY-MM-DD"。訪問者のブラウザのタイムゾーンに関わらず日本時間で揃える。
function jstDateKey(d) {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
// 時間軸のグループ化キー+ラベルを返す。
// 今日/昨日/直近6日以内は日付ごと(exact date)、それより古いものは週/月/年単位に
// まとめて「1週間前」「3ヶ月前」「2年前」のように表示する(古いほど細かい日付は不要なため)。
function timelineBucket(d) {
  const key = jstDateKey(d);
  const now = new Date();
  const nowKey = jstDateKey(now);
  if (key === nowKey) return { key, label: "今日" };
  if (key === jstDateKey(new Date(now.getTime() - 86400000))) return { key, label: "昨日" };

  const [ny, nm, nd] = nowKey.split("-").map(Number);
  const [iy, im, id] = key.split("-").map(Number);
  // 日付差はUTC扱いのタイムスタンプで計算し、夏時間等の影響を受けないようにする
  const daysDiff = Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(iy, im - 1, id)) / 86400000);

  if (daysDiff <= 6) {
    // JSTの00:00固定でDateを作り、ブラウザのローカルタイムゾーンによる曜日ズレを防ぐ
    const wd = WEEKDAY_JA[new Date(`${key}T00:00:00+09:00`).getDay()];
    return { key, label: `${im}/${id}(${wd})` };
  }

  // 暦月ベースの差。まだ同じ日を迎えていなければ1つ手前の月扱いにする
  // (例: 今日8/23に対し7/25は「まだ8/23を迎えていない」ので1ヶ月前ではなく0ヶ月=週表示のまま)
  let monthsDiff = (ny - iy) * 12 + (nm - im);
  if (nd < id) monthsDiff -= 1;

  if (monthsDiff < 1) {
    const weeksAgo = Math.floor(daysDiff / 7);
    return { key: `w${weeksAgo}`, label: `${weeksAgo}週間前` };
  }
  if (monthsDiff < 12) {
    return { key: `m${monthsDiff}`, label: `${monthsDiff}ヶ月前` };
  }
  const yearsAgo = Math.floor(monthsDiff / 12);
  return { key: `y${yearsAgo}`, label: `${yearsAgo}年前` };
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
// 再生数は概数で出す (12時間ごとの更新なので下の桁に意味が無い)。
// YouTube の日本語表記に合わせて 1万以上は「◯.◯万」、それ未満はカンマ区切り。
function fmtViews(n) {
  if (typeof n !== "number" || !isFinite(n)) return "";
  if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, "")}億`;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")}万`;
  return n.toLocaleString();
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
    // 再生数。meta fetcher が12時間ごとに取り直すので最大12時間ぶん古い概数。
    // YouTube のみ (Kick/Twitch は未対応なので null → 表示しない)
    views: typeof v.view_count === "number" ? v.view_count : null,
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
// 配信中のものを、タイムラインのカードと同じ形に変換する。live_status.json には開始時刻が
// 無いので start は「今」= 常に一番新しい扱いにする(降順なら先頭、昇順なら末尾に並ぶ)。
// 前回訪問時に見えていたはずがないので isNew は true (新着境界の計算もこれで整合する)。
function liveItems() {
  const now = new Date();
  return LIVE.map((v) => ({
    platform: v.platform,
    channel: v.channel,
    type: "stream",
    title: v.title || "",
    url: v.url,
    videoId: v.videoId || null,
    start: now,
    durationSec: 0,
    lengthStr: "",
    comments: null,
    thumbnail: v.thumbnail || null,
    available: true,
    commentsKey: null,
    isNew: true,
    isLive: true,
  }));
}

function applyFilters() {
  const q = normalizeText(state.q);
  const live = liveItems();
  // 同じ配信がアーカイブ側にも載っていることがある。Kick は配信中からVODが作られるため
  // 常に、YouTube は配信終了直後(収集がライブ判定より早いとき)に起きる。ライブ側を優先する。
  // 突き合わせは videoId (取れる場合) と、「同じ配信元・チャンネルで同じタイトル かつ
  // 24時間以内に始まった」の2通り (Kick のライブ判定は videoId を持たないため)。
  const liveIds = new Set(live.map((x) => `${x.platform}:${x.videoId}`).filter((k) => !k.endsWith(":null")));
  const liveTitles = new Set(live.map((x) => `${x.platform}|${x.channel}|${x.title}`));
  const dayAgo = Date.now() - 86400000;
  let list = [...live, ...ALL].filter((x) => {
    if (!x.isLive && liveIds.has(`${x.platform}:${x.videoId}`)) return false;
    if (!x.isLive && x.start >= dayAgo && liveTitles.has(`${x.platform}|${x.channel}|${x.title}`)) return false;
    if (state.platform !== "all" && x.platform !== state.platform) return false;
    if (state.channel !== "all" && x.channel !== state.channel) return false;
    if (state.type !== "all" && x.type !== state.type) return false;
    if (state.onlyAvailable && !x.available) return false;
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

  // 配信中は長さが確定していないので出さない (0 のまま出すと "00:00" になる)
  if (!item.isLive) {
    const dur = document.createElement("span");
    dur.className = "duration";
    dur.textContent = fmtDuration(item.durationSec, item.lengthStr);
    wrap.appendChild(dur);
  }

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
  if (item.isLive) card.classList.add("live");
  if (item.available) {
    card.href = item.url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
  } else {
    card.title = "この動画は配信元で削除されています";
  }

  card.appendChild(makeThumb(item));

  // 配信中はカードの赤枠の上に LIVE バッジを重ねる
  if (item.isLive) {
    const dot = document.createElement("span");
    dot.className = "live-dot";
    dot.textContent = "LIVE";
    card.appendChild(dot);
  }

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
  // 配信中は開始時刻を持っていない (start は並べ替え用の「今」) ので日時は出さない
  date.textContent = item.isLive ? "配信中" : fmtDate(item.start);
  meta.appendChild(date);

  const typeTag = document.createElement("span");
  typeTag.className = "tag " + item.type;
  typeTag.textContent = item.type === "stream" ? "配信" : "動画";
  meta.appendChild(typeTag);

  if (item.views != null) {
    const v = document.createElement("span");
    v.className = "views";
    v.textContent = fmtViews(item.views);
    v.title = `${item.views.toLocaleString()}回視聴`;
    meta.appendChild(v);
  }

  if (state.showComments && item.comments != null) {
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
  if (state.showComments && item.comments != null && item.comments > 0) {
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

/* ===== ライブ配信中 ===== */
// GitHub Pages は CDN(Fastly)側でも数分キャッシュされるため、cache:"no-cache" だけでは
// 古い live_status.json を掴まされることがある。クエリを毎回変えてキャッシュキーをずらす。
function liveStatusUrl() {
  return `${CONFIG.sources.liveStatus}?t=${Date.now()}`;
}

// 再描画の要否を判定するためのキー。viewers やサムネURLは配信中ずっと変わり続けるが
// カードには出していないので、これらの変化では作り直さない(スクロール位置を保つため)。
function liveKey(list) {
  return (list || []).map((x) => `${x.platform}:${x.channel}:${x.url}:${x.title}`).join("|");
}

async function refreshLiveStatus() {
  try {
    const r = await fetch(liveStatusUrl(), { cache: "no-cache" });
    if (!r.ok) return;
    const data = await r.json();
    const next = data.live || [];
    const changed = liveKey(next) !== liveKey(LIVE);
    LIVE = next;
    if (changed) render();
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
    const { key, label } = timelineBucket(item.start);
    if (!current || current.key !== key) {
      current = { key, label, items: [] };
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
    // 境界がこのグループの先頭に来る場合、そのままだと日付ラベルと同じ高さに
    // マーカーが並んでしまい重なって見えるため、グループの外(セクションの間)に
    // 独立した行として出す。同じ日の中に新着/既知が混在する場合(グループ途中で
    // 境界を迎える場合)は従来どおりカードの間に挟む。
    const atGroupStart = i === boundary;
    if (atGroupStart) frag.appendChild(makeNewMarker());

    const section = document.createElement("section");
    section.className = "date-group";

    const label = document.createElement("div");
    label.className = "date-label";
    label.textContent = group.label;
    section.appendChild(label);

    const items = document.createElement("div");
    items.className = "date-items " + (state.view === "list" ? "view-list" : "view-grid");
    for (const item of group.items) {
      if (!atGroupStart && i === boundary) items.appendChild(makeNewMarker());
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
  applyTheme();
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
  syncFilterButton();
}

// モバイルでは絞り込みチップが畳まれていて見えないので、いくつ効いているかをボタンに出す。
function syncFilterButton() {
  const btn = document.getElementById("filter-toggle");
  if (!btn) return;
  const active = ["platform", "type", "channel"].filter((k) => state[k] !== "all").length;
  btn.textContent = active ? `絞り込み (${active})` : "絞り込み";
  btn.classList.toggle("has-filter", active > 0);
}

/* ===== 表示設定パネルの見た目を状態に同期 ===== */
function syncSettingsUI() {
  document.getElementById("toggle-timeline").checked = state.timeline;
  document.getElementById("toggle-newmarker").checked = state.newMarker;
  document.getElementById("toggle-comments").checked = state.showComments;
  document.getElementById("toggle-available").checked = state.onlyAvailable;
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
  document.getElementById("toggle-comments").addEventListener("change", (e) => {
    state.showComments = e.target.checked;
    saveSettings();
    render();
  });
  document.getElementById("toggle-available").addEventListener("change", (e) => {
    state.onlyAvailable = e.target.checked;
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

/* ===== 絞り込みパネル (モバイルのみ開閉。デスクトップは常時表示) ===== */
function wireFilterPanel() {
  const btn = document.getElementById("filter-toggle");
  const panel = document.getElementById("filter-groups");
  const close = () => {
    panel.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains("open");
    panel.classList.toggle("open", willOpen);
    btn.setAttribute("aria-expanded", String(willOpen));
  });
  // パネル内のチップ操作では閉じない (複数の条件を続けて選べるように)
  panel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    if (panel.classList.contains("open")) close();
  });
}

/* ===== 起動 ===== */
async function main() {
  // 表示設定(テーマ含む)はデータ取得を待たず先に読み込む。テーマ自体は index.html
  // 冒頭のインラインスクリプトが既にCSS読み込み前に適用済みだが、ここでJS側のstateも
  // 揃えておく(「読み込み中…」表示や設定パネルの見た目にも影響するため)。
  Object.assign(state, loadSettings());
  applyTheme();

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

  markNewItems();

  buildChannelChips();
  readQuery();
  syncChipUI();
  syncSettingsUI();
  wireEvents();
  wireSettingsPanel();
  wireFilterPanel();
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
}

main();
