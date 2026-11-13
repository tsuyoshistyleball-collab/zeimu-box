// =============================================================
// アプリ本体（画面は「保存」「確認」「設定」の3つ）
// =============================================================
import * as drive from "./drive.js";
import { parseStatement, guessMonth, guessMonthFromName } from "./parsers.js";
import { periodOf, periodName, periodLabel, monthsOfPeriod, currentPeriod, fileNameFor } from "./fiscal.js";

const CFG = window.APP_CONFIG;
// 画面の部品を探す。見つからなくてもエラーで止まらないよう、空の部品を返す
// （古い画面と新しいプログラムが混ざっても、ログイン状態の復元などが必ず動くように）
const $ = (sel) => document.querySelector(sel) || document.createElement("div");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const yen = (n) => (n < 0 ? "-" : "") + "¥" + Math.abs(Math.round(n)).toLocaleString("ja-JP");

let accounts = []; // 口座・カード一覧（ドライブのフォルダ）
let pending = []; // 保存待ちのファイル

// ---------- 通知 ----------
let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

// エラーが起きたら通知に出す（毎回 try/catch を書かなくて済むように）
const safe = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { toast(e.message, true); }
};

// ---------- タブ ----------
document.querySelectorAll(".tabbar button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabbar button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
  })
);

// ---------- スワイプでタブを移動（スマホ） ----------
// 指を左へ動かすと右のタブ、右へ動かすと左のタブへ。
// 横に長い表（スクロールできる所）や、入力中の欄の上では、その操作を優先して何もしない。
let swipeStart = null;
document.addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  const scroller = e.target.closest(".scroll");
  // 入力中の欄（カーソルが入っている欄）の上では、文字の操作を優先する
  const blocked = e.touches.length > 1 || e.target === document.activeElement && e.target.matches("input, select, textarea") ||
    (scroller && scroller.scrollWidth > scroller.clientWidth);
  swipeStart = blocked ? null : { x: t.clientX, y: t.clientY };
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (!swipeStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeStart.x, dy = t.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return; // 短い動き・縦の動きは無視
  const tabs = [...document.querySelectorAll(".tabbar button")];
  const next = tabs[tabs.findIndex((b) => b.classList.contains("active")) + (dx < 0 ? 1 : -1)];
  if (next) { next.click(); window.scrollTo(0, 0); }
}, { passive: true });

// ---------- ログイン ----------
const updateAuthBtn = () => ($("#authBtn").textContent = drive.hasLoggedIn() ? "ログアウト" : "ログイン");

$("#authBtn").addEventListener("click", safe(async () => {
  if (drive.hasLoggedIn()) {
    if (!confirm("ログアウトしますか？")) return;
    drive.signOut();
    accounts = [];
    showAccounts();
  } else {
    await drive.signIn();
    await loadAccounts();
    updateAuthBtn();
    await loadDash();
  }
  updateAuthBtn();
}));

async function requireLogin() {
  if (!drive.isSignedIn()) await drive.signIn();
  updateAuthBtn();
  if (!accounts.length || listIsOld()) await loadAccounts();
}

// 端末に覚えている口座一覧が、今のバージョンより前に読み込んだものか
// （アプリの更新で口座の種類が増えたとき、古い一覧のままにならないようにする）
const listIsOld = () => localStorage.getItem("accountsVer") !== window.APP_VERSION;

// ---------- 口座・カード ----------
// 口座 = 「仕事で使用」フォルダの中のフォルダ。解約したものは名前の先頭に【解約】。
// 解約の印：ドライブの「見えない印（appProperties）」に closed=1 を付ける。フォルダ名は変えない。
// もともと名前に【解約】(利用不可)が付いているフォルダも解約済みとして扱う。
const CLOSED = /^(【解約】|\(利用不可\)|（利用不可）)/;
// 期のフォルダ（第7期、４期以前、前期以前 など）
const PERIOD_FOLDER = /^(第\d+期|\d+期以前|前期以前)/;
const half = (s) => s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
const active = () => accounts.filter((a) => !a.closed);
const currentAccount = () => accounts.find((a) => a.id === $("#accountSelect").value);

// 設定の「フォルダ名」からフォルダIDを探す。見つけたIDは端末にだけ覚えておく（コードには書かない）
function applyFolderIds(ids) {
  CFG.ROOT_FOLDER_ID = ids.root;
  CFG.ACCOUNT_GROUPS.forEach((g, i) => (g.folderId = ids.groups?.[i]));
  showDriveLinks();
}
// フォルダの探し方：
//  1) フォルダに付けた見えない印（zeimuRole）で探す … 名前を変えても移動しても見つかる
//  2) 印がまだ無ければ config.js のフォルダ名で探し、見つけたら印を付ける
//  3) どちらでも見つからなければ null（設定画面の「フォルダを指定」でリンクを貼って指定できる）
async function locate(role, path) {
  try {
    let id = await drive.findFolderByTag(role);
    if (!id) {
      id = await drive.findFolderByPath(path);
      await drive.updateMetadata(id, { appProperties: { zeimuRole: role } });
    }
    return id;
  } catch (e) {
    return null;
  }
}
async function resolveFolders() {
  const ids = {
    root: await locate("root", [CFG.ROOT_FOLDER_NAME]),
    groups: await Promise.all(CFG.ACCOUNT_GROUPS.map((g) => locate(g.kind, g.path))),
  };
  localStorage.setItem("folderIds", JSON.stringify(ids));
  applyFolderIds(ids);
  const missing = CFG.ACCOUNT_GROUPS.filter((g) => !g.folderId).map((g) => g.label);
  if (missing.length) toast(`「${missing.join("」「")}」のフォルダが見つかりません。設定の「Googleドライブ」で指定してください`, true);
}

// ドライブから口座一覧を読み込み、端末にも覚えておく（次回すぐ表示できるように）
async function loadAccounts() {
  await resolveFolders();
  const list = [];
  const toAccount = (f, g, name = f.name) => ({
    id: f.id, name, kind: g.kind, groupId: g.folderId,
    url: propsToUrl(f.appProperties) || f.description || "", ownUrl: !!propsToUrl(f.appProperties),
    closedMark: f.appProperties?.closed === "1",
    na: naFromProps(f.appProperties), // 「明細なし」にした月
  });
  for (const g of CFG.ACCOUNT_GROUPS) {
    if (!g.folderId) continue;
    const folders = await drive.listChildren(g.folderId, { foldersOnly: true });
    const subs = g.expandSubfolders
      ? await Promise.all(folders.map(async (f) =>
          (await drive.listChildren(f.id, { foldersOnly: true })).filter((x) => !PERIOD_FOLDER.test(half(x.name)))))
      : [];
    folders.forEach((f, i) => {
      // 中が「GMO-PG振込明細書」などに分かれていれば、その1つ1つを口座として扱う（「第N期」などの期フォルダは除く）
      if (subs[i]?.length) subs[i].forEach((x) => list.push(toAccount(x, g, `${f.name} / ${x.name}`)));
      else list.push(toAccount(f, g));
    });
  }
  localStorage.setItem("accounts", JSON.stringify(list));
  localStorage.setItem("accountsVer", window.APP_VERSION);
  localStorage.setItem("accountsAt", String(Date.now()));
  setAccounts(list);
}

function setAccounts(list) {
  accounts = list
    .map((a) => ({ ...a, group: CFG.ACCOUNT_GROUPS.find((g) => g.folderId === a.groupId), closedByName: CLOSED.test(a.name), closed: CLOSED.test(a.name) || !!a.closedMark }))
    .filter((a) => a.group);
  showAccounts();
}

function showAccounts() {
  if (!accounts.length) {
    $("#accountSelect").innerHTML = `<option value="">ログインしてください</option>`;
    $("#accountList").textContent = "ログインすると表示されます";
    showAccountLink();
    return;
  }
  const last = localStorage.getItem("lastAccount");
  $("#accountSelect").innerHTML = `<option value="">口座・カードを選ぶ</option>` +
    CFG.ACCOUNT_GROUPS.map((g) => `<optgroup label="${esc(g.label)}">` +
      active().filter((a) => a.group === g)
        .map((a) => `<option value="${a.id}" ${a.id === last ? "selected" : ""}>${esc(a.name)}</option>`).join("") +
      `</optgroup>`).join("");
  showAccountLink();
  renderAccountList();
  showListStatus();
}

// 明細ページのURL：フォルダの説明欄 → なければ config.js の LOGIN_LINKS
// 明細ページのURLは、フォルダの見えない印（appProperties）に保存する。
// 印1つに入る文字数が少ないので、100文字ずつ url0〜url4 に分けて入れる（最大500文字）。
const URL_PARTS = 5;
function urlToProps(url) {
  const props = {};
  for (let i = 0; i < URL_PARTS; i++) props["url" + i] = url.slice(i * 100, (i + 1) * 100) || null;
  return props;
}
function propsToUrl(props = {}) {
  let url = "";
  for (let i = 0; i < URL_PARTS; i++) url += props["url" + i] || "";
  return url;
}
const isUrl = (s) => /^https?:\/\/\S+$/.test(s);

function linkFor(acc) {
  if (/^https?:\/\//.test(acc.url)) return acc.url;
  // 売上振込は専用の一覧（SALES_LINKS）を先に見る。「Amazon」がカードと売上で別のページになるため
  const lists = acc.kind === "sales" ? [CFG.SALES_LINKS || {}, CFG.LOGIN_LINKS] : [CFG.LOGIN_LINKS];
  for (const list of lists) {
    const key = Object.keys(list).find((k) => acc.name.includes(k));
    if (key) return list[key];
  }
  return "";
}

// Googleドライブのフォルダを開くURL
const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;
const extLink = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${text}</a>`;

function showAccountLink() {
  const acc = currentAccount();
  const link = acc && linkFor(acc);
  $("#accountLink").innerHTML = acc
    ? (link ? extLink(link, "🔗 明細ページを開く") : "") + extLink(folderUrl(acc.id), "📁 ドライブで見る")
    : "";
}

$("#accountSelect").addEventListener("change", () => {
  localStorage.setItem("lastAccount", $("#accountSelect").value);
  showAccountLink();
  pending.forEach(guess); // カードと銀行で月の決め方が違うので推測し直す
  renderPending();
});

// ---------- 保存 ----------
$("#fileInput").addEventListener("change", (e) => {
  addFiles([...e.target.files]);
  e.target.value = "";
});
const dz = $("#dropZone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  addFiles([...e.dataTransfer.files]);
});

async function addFiles(files) {
  for (const file of files) {
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "csv").toLowerCase();
    const item = { file, ext, buffer: await file.arrayBuffer(), baseName: file.name.replace(/\.[a-z0-9]+$/i, "") };
    guess(item);
    pending.push(item);
  }
  renderPending();
}

// 中身（なければファイル名）から何月分かを推測。わからなければ先月。
function guess(item) {
  const kind = currentAccount()?.kind || "bank";
  item.count = null;
  let g = null;
  if (["csv", "txt"].includes(item.ext)) {
    const parsed = parseStatement(item.buffer, kind);
    item.count = parsed.transactions.length;
    g = guessMonth(parsed, kind);
  }
  g = g || guessMonthFromName(item.file.name);
  if (g && !g.year) { // 「08/12振込予定」のように年が無い名前 → 直近のその月とみなす
    const now = new Date();
    g = { month: g.month, year: g.month > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear() };
  }
  if (!g) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    g = { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  item.ym = `${g.year}-${String(g.month).padStart(2, "0")}`; // <input type="month"> の形式
}

const ymOf = (item) => item.ym.split("-").map(Number); // [年, 月]

// 保存するファイル名：銀行・カードは「R8/8.csv」、売上振込は元の名前（編集可）のまま
function saveNameOf(item, acc) {
  const [y, m] = ymOf(item);
  return acc?.group.keepFileName ? `${item.baseName.trim() || "明細"}.${item.ext}` : fileNameFor(y, m, item.ext);
}

function renderPending() {
  if (!pending.length) return ($("#pending").innerHTML = "");
  $("#pending").innerHTML = `<div class="pending-box">` +
    pending.map((it, i) => {
      const [y, m] = ymOf(it);
      const acc = currentAccount();
      return `<div class="file" data-i="${i}">
        <div class="file-head"><span>${esc(it.file.name)}</span><button class="icon" data-act="remove">✕</button></div>
        ${acc?.group.keepFileName ? `<input type="text" class="name-input" value="${esc(it.baseName)}" data-act="name" placeholder="ファイル名" />` : ""}
        <div class="row">
          <input type="month" value="${it.ym}" data-act="month" />
          <span class="muted"><span class="dest-name">→ ${acc?.group.keepFileName ? "" : periodName(periodOf(y, m)) + " / "}${esc(saveNameOf(it, acc))}</span>${it.count != null ? `（${it.count}件）` : ""}</span>
        </div>
      </div>`;
    }).join("") +
    `<button class="btn wide" id="saveAll" ${currentAccount() ? "" : "disabled"}>
      ${currentAccount() ? `保存する（${pending.length}件）` : "先に口座・カードを選んでください"}</button></div>`;
  $("#saveAll").addEventListener("click", saveAll);
}

$("#pending").addEventListener("change", (e) => {
  const i = e.target.closest(".file")?.dataset.i;
  if (e.target.dataset.act === "month" && e.target.value) {
    pending[i].ym = e.target.value;
    renderPending();
  }
});
$("#pending").addEventListener("input", (e) => {
  if (e.target.dataset.act !== "name") return;
  const row = e.target.closest(".file");
  const it = pending[row.dataset.i];
  it.baseName = e.target.value;
  row.querySelector(".dest-name").textContent = `→ ${saveNameOf(it, currentAccount())}`;
});
$("#pending").addEventListener("click", (e) => {
  if (e.target.dataset.act !== "remove") return;
  pending.splice(e.target.closest(".file").dataset.i, 1);
  renderPending();
});

// ドライブへ：口座フォルダ / 第N期（なければ作る） / R8/8.csv
// 売上振込は、口座フォルダの中に「第N期」フォルダがあればそこへ、なければ口座フォルダに直接（元の名前で）
let busy = false; // 保存中は自動更新（再読み込み）しない
const saveAll = safe(async () => {
  busy = true;
  try { await saveAllInner(); } finally { busy = false; }
});
const saveAllInner = async () => {
  const acc = currentAccount();
  $("#saveAll").disabled = true;
  $("#saveAll").textContent = "保存中…";
  while (pending.length) {
    const it = pending[0];
    const [y, m] = ymOf(it);
    const folder = (await usesPeriodFolders(acc))
      ? await drive.findOrCreateFolder(acc.id, periodName(periodOf(y, m)))
      : acc.id;
    await drive.uploadFile(folder, saveNameOf(it, acc), new Blob([it.buffer], { type: it.file.type || "text/csv" }),
      { month: `${y}-${m}` }); // 何月分かを見えない印で覚えておく（名前に月が無いファイルでも確認画面に出せる）
    pending.shift();
    renderPending();
  }
  toast(`${acc.name} に保存しました`);
  safe(loadDash)(); // ダッシュボードを最新にする
};

// ---------- 期の選択肢・ファイルの月の判定 ----------
const cur = currentPeriod();
for (let n = cur; n >= Math.max(1, cur - 5); n--) {
  $("#period").insertAdjacentHTML("beforeend", `<option value="${n}">${periodLabel(n)}</option>`);
}

// 「明細なし（△）」の月は、口座フォルダの見えない印に「na7 = "8,9"」（第7期の8月と9月）の形で保存する
function naFromProps(props = {}) {
  const na = {};
  for (const [k, v] of Object.entries(props || {})) {
    const m = k.match(/^na(\d+)$/);
    if (m && v) na[m[1]] = v.split(",").map(Number);
  }
  return na;
}

// ファイルが何月分か：保存時に付けた見えない印 → なければファイル名から
function monthOfFile(f, months) {
  const mark = f.appProperties?.month?.match(/^(\d{4})-(\d{1,2})$/);
  if (mark) return { year: Number(mark[1]), month: Number(mark[2]) };
  const g = guessMonthFromName(f.name);
  // 「01/28振込予定」のように年が無い名前は、ファイルをドライブに入れた日から年を決める。
  // （入れた日より前で一番近いその月。振込「予定」なので1か月半先までは同じ年とみなす）
  if (g && !g.year) {
    const made = new Date(f.createdTime || Date.now());
    const limit = new Date(made.getTime() + 45 * 24 * 60 * 60 * 1000);
    g.year = new Date(made.getFullYear() + 1, g.month - 1, 1) <= limit ? made.getFullYear() + 1
      : new Date(made.getFullYear(), g.month - 1, 1) <= limit ? made.getFullYear() : made.getFullYear() - 1;
  }
  return g;
}

// 「第N期」フォルダを使う口座か（銀行・カードはいつも使う。売上振込は中に「第N期」があるときだけ）
async function usesPeriodFolders(acc) {
  if (!acc.group.keepFileName) return true;
  return (await drive.listChildren(acc.id, { foldersOnly: true })).some((f) => /^第\d+期/.test(half(f.name)));
}

// 口座の、その期のファイル（「第３期＿済」のような名前にも対応）。
// 期のフォルダが無い口座（Amazonなど）は、口座フォルダ直下のファイルから、その期の月のものを選ぶ。
async function filesInPeriod(acc, n) {
  const folder = (await drive.listChildren(acc.id, { foldersOnly: true }))
    .find((f) => new RegExp(`^${periodName(n)}(?!\\d)`).test(half(f.name)));
  if (folder) return { folderId: folder.id, files: (await drive.listChildren(folder.id)).filter((f) => !f.mimeType.includes("folder")) };
  if (!acc.group.keepFileName) return { folderId: null, files: [] };
  const months = monthsOfPeriod(n);
  const files = (await drive.listChildren(acc.id)).filter((f) => {
    if (f.mimeType.includes("folder")) return false;
    const g = monthOfFile(f, months);
    return g?.year && months.some((m) => m.year === g.year && m.month === g.month);
  });
  return { folderId: null, files };
}

// ---------- ダッシュボード ----------
// データの流れ：loadDash() がドライブから集めて dash に入れる → renderDash() が画面を描く。
// 集めた結果は端末にも覚えておき（dash_期の番号）、次に開いたときはすぐ表示する。
let dash = null; // { n, at, rows:[{id,name,kind,folderId,saved:{"2026-8":url}}], money:{...} }
let allTx = []; // 取引の一覧（検索用。端末には保存しない）
const periodN = () => Number($("#period").value);
const ymKey = (m) => `${m.year}-${m.month}`;

// 金額を短く：1,234,567 → 123万 ／ 123,456,789 → 1.2億
function compactYen(v) {
  const a = Math.abs(v), sign = v < 0 ? "-" : "";
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(1)}億`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(a < 1e5 ? 1 : 0)}万`;
  return `${sign}${Math.round(a).toLocaleString("ja-JP")}`;
}
// グラフの目盛りの上限を、きりのいい数にする
function niceMax(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * pow).find((x) => v <= x);
}

// ドライブから集める
async function loadDash() {
  await requireLogin();
  const n = periodN();
  const months = monthsOfPeriod(n);
  const inPeriod = new Set(months.map(ymKey));
  $("#dash").classList.add("loading"); // 前の表示を薄く残す（画面ががたつかないように）
  $("#dashStatus").textContent = "ドライブから読み込み中…";
  const tx = [];
  const money = { bankIn: 0, bankOut: 0, card: 0, byMonth: {}, files: 0, txCount: 0 };
  const payee = new Map();
  const addMonth = (key, field, v) => {
    if (!inPeriod.has(key)) return;
    money.byMonth[key] = money.byMonth[key] || { bankIn: 0, bankOut: 0, card: 0 };
    money.byMonth[key][field] += v;
    money[field] += v;
  };
  try {
    const rows = await Promise.all(active().map(async (acc) => {
      const saved = {};
      const { folderId, files } = await filesInPeriod(acc, n);
      for (const f of files) {
        const fm = monthOfFile(f, months);
        if (fm?.year) saved[ymKey(fm)] = f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`;
        money.files++;
        // お金の集計は、銀行とカードのCSVだけを読む
        if (acc.kind === "sales" || !(/csv|text/.test(f.mimeType) || /\.csv$/i.test(f.name))) continue;
        for (const t of parseStatement(await drive.downloadFile(f.id), acc.kind).transactions) {
          tx.push({ ...t, account: acc.name });
          money.txCount++;
          const txKey = `${t.date.getFullYear()}-${t.date.getMonth() + 1}`;
          if (acc.kind === "card") addMonth(fm?.year ? ymKey(fm) : txKey, "card", -t.amount); // カードは支払月で数える
          else addMonth(txKey, t.amount > 0 ? "bankIn" : "bankOut", Math.abs(t.amount));
          if (t.amount < 0 && t.desc) {
            const p = payee.get(t.desc) || { amount: 0, count: 0 };
            p.amount += -t.amount; p.count++;
            payee.set(t.desc, p);
          }
        }
      }
      return { id: acc.id, name: acc.name, kind: acc.kind, folderId, saved };
    }));
    money.payees = [...payee].map(([name, p]) => ({ name, ...p })).sort((a, b) => b.amount - a.amount).slice(0, 8);
    allTx = tx.sort((a, b) => a.date - b.date);
    dash = { n, at: Date.now(), rows, money };
    localStorage.setItem("dash_" + n, JSON.stringify(dash));
  } finally {
    $("#dash").classList.remove("loading");
    renderDash();
  }
}

// 端末に覚えている分を表示
function showCachedDash() {
  allTx = [];
  try { dash = JSON.parse(localStorage.getItem("dash_" + periodN()) || "null"); } catch { dash = null; }
  renderDash();
}

// 口座×月の状態を数える（ok＝保存済み / na＝明細なし / missing＝未保存 / future＝まだ先）
function dashStats() {
  const n = dash.n, months = monthsOfPeriod(n), now = new Date();
  const due = months.filter((m) => new Date(m.year, m.month - 1) <= now);
  const rows = dash.rows.map((r) => ({ ...r, acc: accounts.find((a) => a.id === r.id) })).filter((r) => r.acc && !r.acc.closed);
  for (const r of rows) {
    r.cells = months.map((m) => {
      if (r.saved[ymKey(m)]) return "ok";
      if (!due.includes(m)) return "future";
      return r.acc.na?.[n]?.includes(m.month) ? "na" : "missing";
    });
    r.count = (s) => r.cells.filter((c) => c === s).length;
  }
  const sum = (list, s) => list.reduce((t, r) => t + r.count(s), 0);
  const ratio = (list) => {
    const ok = sum(list, "ok"), na = sum(list, "na"), missing = sum(list, "missing");
    const total = ok + na + missing;
    return { ok, na, missing, total, done: ok + na, pct: total ? Math.round(((ok + na) / total) * 100) : 0 };
  };
  const byMonth = months.map((m, i) => {
    const c = (s) => rows.filter((r) => r.cells[i] === s).length;
    const total = c("ok") + c("na") + c("missing");
    return { m, future: !due.includes(m), ok: c("ok"), na: c("na"), missing: c("missing"), total, pct: total ? Math.round(((c("ok") + c("na")) / total) * 100) : 0 };
  });
  return { n, months, rows, all: ratio(rows), byMonth,
    groups: CFG.ACCOUNT_GROUPS.map((g) => ({ label: g.label, ...ratio(rows.filter((r) => r.kind === g.kind)) })) };
}

// 棒グラフ（縦）。values: [{label, value, tip, muted}]。一番大きい棒だけ数字を出し、ほかは目盛りと吹き出しで読む
function columnChart(values, { series = 1, fmt = compactYen } = {}) {
  const max = niceMax(Math.max(...values.map((v) => v.value), 0));
  const top = Math.max(...values.map((v) => v.value));
  return `<div class="chart">
    <div class="yaxis"><span>${fmt(max)}</span><span>${fmt(max / 2)}</span><span>0</span></div>
    <div class="plot"><i class="gl" style="bottom:50%"></i><i class="gl" style="bottom:100%"></i>
      ${values.map((v) => `<div class="col" tabindex="0" data-tip="${esc(v.tip)}">
        ${v.value > 0 && v.value === top ? `<b style="bottom:${(v.value / max) * 100}%">${fmt(v.value)}</b>` : ""}
        <i class="bar s${series}" style="height:${(v.value / max) * 100}%"></i></div>`).join("")}
    </div>
    <div></div><div class="xaxis">${values.map((v) => `<span>${esc(v.label)}</span>`).join("")}</div>
  </div>`;
}

function renderDash() {
  const el = $("#dash");
  if (!dash) {
    $("#dashStatus").textContent = "";
    el.innerHTML = `<div class="card empty"><h2>まだデータがありません</h2>
      <p class="muted">「🔄 更新」を押すと、Googleドライブから保存状況を読み込みます。</p></div>`;
    return;
  }
  const s = dashStats(), money = dash.money, n = s.n;
  const when = new Date(dash.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  $("#dashStatus").textContent = `最終更新：${when}`;
  const cell = (r, m, i) => {
    const c = r.cells[i];
    if (c === "ok") return `<td class="ok">${extLink(r.saved[ymKey(m)], "✓")}</td>`;
    if (c === "future") return `<td></td>`;
    return `<td class="${c} toggle" data-acc="${r.id}" data-month="${m.month}" title="押すと − と △ を切り替え">${c === "na" ? "△" : "−"}</td>`;
  };
  const todo = s.rows.filter((r) => r.count("missing")).sort((a, b) => b.count("missing") - a.count("missing"));
  const mv = (field) => s.months.map((m) => {
    const v = money.byMonth[ymKey(m)]?.[field] || 0;
    return { label: `${m.month}月`, value: v, tip: `${m.year}年${m.month}月　${yen(v)}` };
  });
  const payMax = Math.max(...(money.payees || []).map((p) => p.amount), 1);

  el.innerHTML = `
    <div class="dgrid">
      <div class="card hero">
        <div class="label">${esc(periodName(n))}の明細の進み具合</div>
        <div class="hero-row"><div class="hero-num">${s.all.pct}<small>%</small></div>
          <div class="hero-side"><div class="meter"><i style="width:${s.all.pct}%"></i></div>
          <div class="muted">今日までに必要な ${s.all.total} 件のうち ${s.all.done} 件が完了${s.all.missing ? `、<b>あと ${s.all.missing} 件</b>` : " 🎉"}</div></div></div>
      </div>
      <div class="tiles">
        <div class="tile"><span>未保存</span><b>${s.all.missing}</b><small><i class="dot crit"></i>これから入れる明細</small></div>
        <div class="tile"><span>保存済み</span><b>${s.all.ok}</b><small><i class="dot good"></i>ドライブにある月</small></div>
        <div class="tile"><span>明細なし</span><b>${s.all.na}</b><small>△ を付けた月</small></div>
        <div class="tile"><span>口座・カード・売上</span><b>${s.rows.length}</b><small>使用中の数</small></div>
      </div>
    </div>

    <div class="dgrid two">
      <div class="card">
        <h3>種類ごとの進み具合</h3>
        ${s.groups.map((g) => `<div class="mrow" tabindex="0" data-tip="${esc(g.label)}　保存済み ${g.ok}・明細なし ${g.na}・未保存 ${g.missing}">
          <span class="mname">${esc(g.label)}</span>
          <div class="meter"><i style="width:${g.pct}%"></i></div>
          <span class="mval">${g.done}/${g.total}<small>（${g.pct}%）</small></span></div>`).join("")}
      </div>
      <div class="card">
        <h3>月ごとの進み具合</h3>
        <div class="chart">
          <div class="yaxis"><span>100%</span><span>50%</span><span>0</span></div>
          <div class="plot"><i class="gl" style="bottom:50%"></i><i class="gl" style="bottom:100%"></i>
            ${s.byMonth.map((b) => `<div class="col" tabindex="0" data-tip="${b.future ? `${b.m.month}月　まだ先の月` : `${b.m.month}月　${b.pct}%（保存済み ${b.ok}・明細なし ${b.na}・未保存 ${b.missing}）`}">
              <i class="bar track ${b.future ? "future" : ""}"><i style="height:${b.future ? 0 : b.pct}%"></i></i></div>`).join("")}
          </div>
          <div></div><div class="xaxis">${s.byMonth.map((b) => `<span>${b.m.month}月</span>`).join("")}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>まだ入れていない明細 <small class="muted">${todo.length} 口座</small></h3>
      ${todo.length ? todo.map((r) => `<div class="todo" data-acc="${r.id}">
        <div><b>${esc(r.name)}</b>
          <div class="chips">${s.months.filter((m, i) => r.cells[i] === "missing").map((m) => `<span>${m.month}月</span>`).join("")}</div></div>
        <div class="todo-actions">
          ${linkFor(r.acc) ? `<a class="btn small ghost" href="${esc(linkFor(r.acc))}" target="_blank" rel="noopener">明細ページ</a>` : ""}
          <button class="btn small" data-act="add">追加</button>
          <button class="btn small ghost" data-act="na-all" title="この口座の未保存の月をすべて「明細なし（△）」にする">明細なし</button>
        </div></div>`).join("")
        : `<p class="muted">未保存の明細はありません 🎉</p>`}
    </div>

    <div class="card">
      <h3>お金の動き <small class="muted">保存したCSVから集計（${money.txCount.toLocaleString()} 件の取引）</small></h3>
      <div class="tiles three">
        <div class="tile"><span>銀行 入金</span><b>${compactYen(money.bankIn)}</b><small>${yen(money.bankIn)}</small></div>
        <div class="tile"><span>銀行 出金</span><b>${compactYen(money.bankOut)}</b><small>${yen(money.bankOut)}</small></div>
        <div class="tile"><span>カード利用</span><b>${compactYen(money.card)}</b><small>${yen(money.card)}</small></div>
      </div>
      <div class="dgrid two inner">
        <div><h4><i class="key s1"></i>銀行の出金（月別）</h4>${columnChart(mv("bankOut"), { series: 1 })}</div>
        <div><h4><i class="key s2"></i>カードの利用（支払月別）</h4>${columnChart(mv("card"), { series: 2 })}</div>
      </div>
      <details><summary>表で見る</summary><div class="scroll"><table class="tx">
        <thead><tr><th>月</th><th class="num">銀行 入金</th><th class="num">銀行 出金</th><th class="num">カード利用</th></tr></thead>
        <tbody>${s.months.map((m) => { const v = money.byMonth[ymKey(m)] || {}; return `<tr><td>${m.year}/${m.month}</td><td class="num">${yen(v.bankIn || 0)}</td><td class="num">${yen(v.bankOut || 0)}</td><td class="num">${yen(v.card || 0)}</td></tr>`; }).join("")}</tbody>
      </table></div></details>
    </div>

    <div class="card">
      <h3>支払・出金の多い相手 <small class="muted">上位8件</small></h3>
      ${(money.payees || []).length ? money.payees.map((p) => `<div class="hbar" tabindex="0" data-tip="${esc(p.name)}　${yen(p.amount)}（${p.count}回）">
        <span class="hname">${esc(p.name)}</span>
        <div class="htrack"><i class="bar s1" style="width:${(p.amount / payMax) * 100}%"></i></div>
        <span class="hval">${compactYen(p.amount)}</span></div>`).join("")
        : `<p class="muted">CSVの明細を保存すると表示されます。</p>`}
    </div>

    <div class="card">
      <h3>保存状況の一覧</h3>
      <div class="scroll"><table class="grid">
        <thead><tr><th></th>${s.months.map((m) => `<th>${m.month}月</th>`).join("")}</tr></thead>
        <tbody>${CFG.ACCOUNT_GROUPS.map((g) => {
          const list = s.rows.filter((r) => r.kind === g.kind);
          return list.length ? `<tr class="ghead"><th colspan="13">${esc(g.label)}</th></tr>` + list.map((r) =>
            `<tr><th>${extLink(folderUrl(r.folderId || r.id), esc(r.name))}</th>${s.months.map((m, i) => cell(r, m, i)).join("")}</tr>`).join("") : "";
        }).join("")}</tbody>
      </table></div>
      <p class="muted">✓ 保存済み　− 未保存　△ 明細なし　｜　<b>− を押すと △ に変えられます</b>（もう一度押すと戻ります）。口座名や ✓ を押すとドライブが開きます。</p>
    </div>

    <div class="card">
      <h3>取引をさがす</h3>
      ${allTx.length ? `<div class="row"><input id="search" type="search" placeholder="お店の名前など（例：AMAZON）" />
        <button id="exportBtn" class="btn ghost">CSV</button></div><div id="txList"></div>`
        : `<p class="muted">「🔄 更新」を押すと、取引を検索できます。</p>`}
    </div>`;
  if (allTx.length) {
    renderTx();
    $("#search").addEventListener("input", renderTx);
    $("#exportBtn").addEventListener("click", () => exportCsv(n));
  }
}

// 「明細なし（△）」を保存する。months: その期で △ にする月の一覧
async function saveNa(acc, n, monthsList) {
  const before = acc.na;
  acc.na = { ...acc.na, [n]: monthsList };
  renderDash(); // 先に表示を変える
  try {
    await drive.updateMetadata(acc.id, { appProperties: { ["na" + n]: monthsList.join(",") || null } });
  } catch (err) {
    acc.na = before; // 保存できなかったら元に戻す
    renderDash();
    throw err;
  }
  const cache = JSON.parse(localStorage.getItem("accounts") || "[]");
  const c = cache.find((a) => a.id === acc.id);
  if (c) { c.na = acc.na; localStorage.setItem("accounts", JSON.stringify(cache)); }
}

$("#dash").addEventListener("click", safe(async (e) => {
  const n = String(dash?.n);
  // 表の − ⇄ △
  const td = e.target.closest("td.toggle");
  if (td) {
    const acc = accounts.find((a) => a.id === td.dataset.acc);
    const list = new Set(acc.na?.[n] || []);
    const month = Number(td.dataset.month);
    list.has(month) ? list.delete(month) : list.add(month);
    return saveNa(acc, n, [...list]);
  }
  const act = e.target.dataset.act;
  const acc = accounts.find((a) => a.id === e.target.closest(".todo")?.dataset.acc);
  if (!act || !acc) return;
  if (act === "add") openAddPanel(acc.id);
  if (act === "na-all") {
    const row = dashStats().rows.find((r) => r.id === acc.id);
    const missing = monthsOfPeriod(dash.n).filter((m, i) => row.cells[i] === "missing").map((m) => m.month);
    if (!confirm(`「${acc.name}」の未保存の月（${missing.map((m) => m + "月").join("・")}）を、すべて「明細なし（△）」にしますか？`)) return;
    await saveNa(acc, n, [...new Set([...(acc.na?.[n] || []), ...missing])]);
  }
}));

// 「＋ 明細を追加」の欄を開く
function openAddPanel(accountId) {
  $("#addPanel").hidden = false;
  if (accountId) {
    $("#accountSelect").value = accountId;
    $("#accountSelect").dispatchEvent(new Event("change"));
  }
  $("#addPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("#addOpen").addEventListener("click", () => {
  if ($("#addPanel").hidden) openAddPanel(); else $("#addPanel").hidden = true;
});
$("#dashRefresh").addEventListener("click", safe(loadDash));
$("#period").addEventListener("change", () => {
  showCachedDash();
  if (drive.isSignedIn()) safe(loadDash)();
});

// グラフの吹き出し（マウスを乗せる・タップ・キーボードで選ぶと出る）
const tip = $("#tip");
function showTip(target) {
  tip.textContent = target.dataset.tip; // textContent なので、名前に記号が入っていても安全
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const x = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + "px";
  tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + "px";
}
for (const ev of ["pointerover", "focusin"]) {
  document.addEventListener(ev, (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (t) showTip(t); else tip.hidden = true;
  });
}
document.addEventListener("scroll", () => (tip.hidden = true), { passive: true });

function filteredTx() {
  const w = ($("#search")?.value || "").trim().toLowerCase();
  return allTx.filter((t) => !w || (t.desc + t.account).toLowerCase().includes(w));
}

function renderTx() {
  const list = filteredTx();
  $("#txList").innerHTML = `<p class="muted">${list.length}件　合計 ${yen(list.reduce((s, t) => s + t.amount, 0))}</p>` +
    `<div class="scroll"><table class="tx"><tbody>` +
    list.slice(0, 300).map((t) => `<tr><td>${t.date.toLocaleDateString("ja-JP")}</td><td>${esc(t.desc)}<br><small class="muted">${esc(t.account)}</small></td><td class="num ${t.amount < 0 ? "neg" : ""}">${yen(t.amount)}</td></tr>`).join("") +
    `</tbody></table></div>`;
}

function exportCsv(n) {
  const rows = [["日付", "口座", "内容", "金額"], ...filteredTx().map((t) =>
    [t.date.toLocaleDateString("ja-JP"), t.account, t.desc, t.amount])];
  const csv = "﻿" + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `${periodName(n)}_取引一覧.csv`;
  a.click();
}

// ---------- 設定：口座・カードの追加と解約 ----------
$("#newKind").innerHTML = CFG.ACCOUNT_GROUPS.map((g, i) => `<option value="${i}">${esc(g.label)}</option>`).join("");

$("#addForm").addEventListener("submit", safe(async (e) => {
  e.preventDefault();
  const name = $("#newName").value.trim();
  const url = $("#newUrl").value.trim();
  if (url && !isUrl(url)) return toast("URLは https:// から入れてください", true);
  if (url.length > URL_PARTS * 100) return toast("URLが長すぎます（500文字まで）", true);
  await requireLogin();
  const group = CFG.ACCOUNT_GROUPS[$("#newKind").value];
  if (!group.folderId) return toast(`「${group.path.join(" / ")}」フォルダが見つからないため追加できません`, true);
  await drive.createFolder(group.folderId, name, url ? urlToProps(url) : {});
  e.target.reset();
  await loadAccounts();
  toast(`「${name}」を追加しました`);
}));

$("#showClosed").addEventListener("change", renderAccountList);

function renderAccountList() {
  const show = $("#showClosed").checked;
  showListStatus();
  if (!accounts.length) return ($("#accountList").textContent = "ログインすると表示されます");
  // リンク先は「どのサイトか」が分かるように、サイト名（ドメイン）を表示する
  const urlText = (a) => {
    const link = linkFor(a);
    if (!link) return `<span class="warn">明細ページ：未設定（「URL」から入れられます）</span>`;
    let host = link;
    try { host = new URL(link).hostname; } catch {}
    return `明細ページ：<a href="${esc(link)}" target="_blank" rel="noopener">${esc(host)}</a>${a.ownUrl ? "" : "（自動）"}`;
  };
  $("#accountList").innerHTML = CFG.ACCOUNT_GROUPS.map((g) => {
    const list = accounts.filter((a) => a.group === g && (show || !a.closed));
    return `<h3 class="group-head">${esc(g.label)}</h3>` + (list.length ? list.map((a) => `
    <div class="acct ${a.closed ? "closed" : ""}" data-id="${a.id}">
      <div>
        <span>${esc(a.name)}</span>
        <small class="acct-url">${urlText(a)}</small>
      </div>
      <div class="acct-actions">
        <button class="btn small ghost" data-act="url">URL</button>
        ${a.closedByName ? `<small>名前で解約済み</small>`
          : `<button class="btn small ghost" data-act="${a.closed ? "reopen" : "close"}">${a.closed ? "戻す" : "解約"}</button>`}
      </div>
    </div>`).join("") : (listIsOld() || !g.folderId
      ? `<p class="warn">まだ読み込めていません。上の「🔄 最新にする」を押してください。</p>`
      : `<p class="muted">なし</p>`));
  }).join("");
}

// 一覧をいつ読み込んだかを表示。古いときは目立たせる
function showListStatus() {
  const at = Number(localStorage.getItem("accountsAt") || 0);
  const when = at ? new Date(at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const old = drive.hasLoggedIn() && listIsOld();
  document.querySelectorAll(".list-status").forEach((el) => {
    el.textContent = !drive.hasLoggedIn() ? "" : old ? "⚠️ 一覧が古いです。「🔄 最新にする」を押してください" : `ドライブから読み込み：${when}`;
    el.classList.toggle("warn", old);
  });
}

// 「🔄 最新にする」：ドライブから口座一覧を読み込み直す
document.querySelectorAll(".refresh-btn").forEach((b) => b.addEventListener("click", safe(async () => {
  if (!drive.isSignedIn()) await drive.signIn();
  updateAuthBtn();
  await loadAccounts();
  // 見つからないフォルダがあるときは、その注意の通知を残す
  if (CFG.ACCOUNT_GROUPS.every((g) => g.folderId)) toast("口座一覧を最新にしました");
})));

// URL＝明細ページのURLを編集／解約・戻す＝見えない印を付け外し（フォルダ名や明細はそのまま）
$("#accountList").addEventListener("click", safe(async (e) => {
  const acc = accounts.find((a) => a.id === e.target.closest(".acct")?.dataset.id);
  const act = e.target.dataset.act;
  if (!acc || !act) return;
  if (act === "url") {
    const url = prompt(`「${acc.name}」の明細ページのURL\n（空にすると自動のURLに戻ります）`, acc.ownUrl ? acc.url : linkFor(acc));
    if (url === null) return; // キャンセル
    const v = url.trim();
    if (v && !isUrl(v)) return toast("URLは https:// から入れてください", true);
    if (v.length > URL_PARTS * 100) return toast("URLが長すぎます（500文字まで）", true);
    await drive.updateMetadata(acc.id, { appProperties: urlToProps(v) });
    toast(v ? "URLを保存しました" : "自動のURLに戻しました");
  } else if (act === "close") {
    if (!confirm(`「${acc.name}」を解約済みにしますか？（明細は消えません）`)) return;
    await drive.updateMetadata(acc.id, { appProperties: { closed: "1" } });
  } else {
    await drive.updateMetadata(acc.id, { appProperties: { closed: null } });
  }
  await loadAccounts();
}));

// ---------- 設定：Google ----------
$("#clientIdInput").value = drive.getClientId();
$("#saveClientId").addEventListener("click", () => {
  localStorage.setItem("clientId", $("#clientIdInput").value.trim());
  toast("保存しました。右上の「ログイン」を押してください");
});

// ---------- インストール・共有の受け取り ----------
let installEvent;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("#installBtn").hidden = false;
});
$("#installBtn").addEventListener("click", () => installEvent?.prompt());

// updateViaCache:"none" … アプリ更新の確認ではブラウザの保存済みファイルを使わない
let swReg = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => (swReg = r)).catch(() => {});
}

// ---------- 新しいバージョンが出たら自動で切り替える ----------
// サーバーの version.js（ブラウザの保存を使わず毎回取りに行く）と、今のバージョンを比べる。
// 違っていたら、サービスワーカーを更新してからページを読み込み直す。
async function checkForUpdate() {
  if (busy || pending.length) return; // 保存待ち・保存中のファイルがあるときは待つ
  try {
    const text = await (await fetch(`version.js?t=${Date.now()}`, { cache: "no-store" })).text();
    const latest = text.match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1];
    if (!latest || latest === window.APP_VERSION) return;
    // 読み込み直しても古いままだった場合（配信の反映待ち）は、1分あけてからもう一度試す
    const last = JSON.parse(sessionStorage.getItem("reloadTry") || "{}");
    if (last.v === latest && Date.now() - last.at < 60 * 1000) return;
    sessionStorage.setItem("reloadTry", JSON.stringify({ v: latest, at: Date.now() }));
    $("#headerVersion").textContent = `v${latest} に更新中…`;
    await swReg?.update().catch(() => {});
    location.reload();
  } catch { /* オフラインなどのときは何もしない */ }
}
checkForUpdate();
setInterval(checkForUpdate, 60 * 1000); // 1分ごと
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); }); // アプリを開き直したとき

// Androidの「共有」→「税務ボックス」で送られてきたファイル
async function receiveShared() {
  if (!new URLSearchParams(location.search).has("shared")) return;
  const cache = await caches.open("shared-files");
  const files = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    const name = new URL(req.url).searchParams.get("name") || "shared.csv";
    files.push(new File([await res.blob()], name, { type: res.headers.get("content-type") || "" }));
    await cache.delete(req);
  }
  history.replaceState(null, "", location.pathname);
  if (files.length) { openAddPanel(); addFiles(files); }
}

// ---------- ドライブへの直リンク ----------
// 設定の「Googleドライブ」欄：各フォルダへのリンクと、フォルダを指定し直すボタン
function folderSlots() {
  return [{ role: "root", label: "明細フォルダ（全体）", folderId: CFG.ROOT_FOLDER_ID },
    ...CFG.ACCOUNT_GROUPS.map((g) => ({ role: g.kind, label: g.label, folderId: g.folderId }))];
}
function showDriveLinks() {
  $("#driveLink").href = CFG.ROOT_FOLDER_ID ? folderUrl(CFG.ROOT_FOLDER_ID) : "https://drive.google.com/";
  if (!drive.hasLoggedIn()) return ($("#driveLinks").textContent = "ログインすると表示されます");
  $("#driveLinks").innerHTML = folderSlots().map((f) => `
    <div class="acct" data-role="${f.role}">
      <div>${f.folderId ? extLink(folderUrl(f.folderId), "📁 " + esc(f.label)) : `<span class="warn">⚠️ ${esc(f.label)}：フォルダが見つかりません</span>`}</div>
      <button class="btn small ghost" data-act="pick">${f.folderId ? "変更" : "フォルダを指定"}</button>
    </div>`).join("");
}

// フォルダを指定：ドライブのフォルダのリンクを貼ってもらい、そのフォルダに印を付ける
$("#driveLinks").addEventListener("click", safe(async (e) => {
  if (e.target.dataset.act !== "pick") return;
  const slot = folderSlots().find((f) => f.role === e.target.closest(".acct").dataset.role);
  const input = prompt(`「${slot.label}」のフォルダを指定します。\nGoogleドライブでそのフォルダを開き、アドレス（URL）をコピーして貼ってください。`);
  if (!input) return;
  const id = input.match(/folders\/([\w-]+)/)?.[1] || input.match(/[?&]id=([\w-]+)/)?.[1] || (/^[\w-]{20,}$/.test(input.trim()) ? input.trim() : null);
  if (!id) return toast("フォルダのリンクを読み取れませんでした（drive.google.com/drive/folders/… の形のURLを貼ってください）", true);
  if (!drive.isSignedIn()) await drive.signIn();
  const file = await drive.getFile(id);
  if (!file.mimeType.includes("folder") || file.trashed) return toast("これはフォルダではありません。フォルダのリンクを貼ってください", true);
  if (!confirm(`「${slot.label}」のフォルダを「${file.name}」にします。よろしいですか？`)) return;
  if (slot.folderId && slot.folderId !== id) await drive.updateMetadata(slot.folderId, { appProperties: { zeimuRole: null } }).catch(() => {});
  await drive.updateMetadata(id, { appProperties: { zeimuRole: slot.role } });
  await loadAccounts();
  toast(`「${slot.label}」のフォルダを「${file.name}」にしました`);
}));

// ---------- 起動 ----------
// 前回の口座一覧をすぐ表示 → 通行証が有効ならドライブから最新に更新
$("#appVersion").textContent = `バージョン ${window.APP_VERSION}`;
$("#headerVersion").textContent = `v${window.APP_VERSION}`;
updateAuthBtn();
showDriveLinks();
if (drive.hasLoggedIn()) {
  try { applyFolderIds(JSON.parse(localStorage.getItem("folderIds") || "{}")); } catch {}
  try { setAccounts(JSON.parse(localStorage.getItem("accounts") || "[]")); } catch {}
  showListStatus();
  showCachedDash();
  // 通行証が有効なら、口座一覧 → ダッシュボードの順にドライブから最新にする
  if (drive.isSignedIn()) safe(async () => { await loadAccounts(); await loadDash(); })();
} else {
  renderDash();
}
receiveShared();
if (!drive.getClientId()) {
  $("#googleCard").open = true;
  document.querySelector('[data-tab="settings"]').click();
}
