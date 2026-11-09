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
  }
  updateAuthBtn();
}));

async function requireLogin() {
  if (!drive.isSignedIn()) await drive.signIn();
  updateAuthBtn();
  if (!accounts.length) await loadAccounts();
}

// ---------- 口座・カード ----------
// 口座 = 「仕事で使用」フォルダの中のフォルダ。解約したものは名前の先頭に【解約】。
// 解約の印：ドライブの「見えない印（appProperties）」に closed=1 を付ける。フォルダ名は変えない。
// もともと名前に【解約】(利用不可)が付いているフォルダも解約済みとして扱う。
const CLOSED = /^(【解約】|\(利用不可\)|（利用不可）)/;
const active = () => accounts.filter((a) => !a.closed);
const currentAccount = () => accounts.find((a) => a.id === $("#accountSelect").value);

// 設定の「フォルダ名」からフォルダIDを探す。見つけたIDは端末にだけ覚えておく（コードには書かない）
function applyFolderIds(ids) {
  CFG.ROOT_FOLDER_ID = ids.root;
  CFG.ACCOUNT_GROUPS.forEach((g, i) => (g.folderId = ids.groups?.[i]));
  showDriveLinks();
}
async function resolveFolders() {
  const ids = {
    root: await drive.findFolderByPath([CFG.ROOT_FOLDER_NAME]),
    groups: await Promise.all(CFG.ACCOUNT_GROUPS.map((g) => drive.findFolderByPath([CFG.ROOT_FOLDER_NAME, ...g.path]))),
  };
  localStorage.setItem("folderIds", JSON.stringify(ids));
  applyFolderIds(ids);
}

// ドライブから口座一覧を読み込み、端末にも覚えておく（次回すぐ表示できるように）
async function loadAccounts() {
  await resolveFolders();
  const list = [];
  for (const g of CFG.ACCOUNT_GROUPS) {
    for (const f of await drive.listChildren(g.folderId, { foldersOnly: true })) {
      list.push({ id: f.id, name: f.name, kind: g.kind, groupId: g.folderId, url: propsToUrl(f.appProperties) || f.description || "", ownUrl: !!propsToUrl(f.appProperties), closedMark: f.appProperties?.closed === "1" });
    }
  }
  localStorage.setItem("accounts", JSON.stringify(list));
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
  const key = Object.keys(CFG.LOGIN_LINKS).find((k) => acc.name.includes(k));
  return key ? CFG.LOGIN_LINKS[key] : "";
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
    const item = { file, ext, buffer: await file.arrayBuffer() };
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
  if (!g) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    g = { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  item.ym = `${g.year}-${String(g.month).padStart(2, "0")}`; // <input type="month"> の形式
}

const ymOf = (item) => item.ym.split("-").map(Number); // [年, 月]

function renderPending() {
  if (!pending.length) return ($("#pending").innerHTML = "");
  $("#pending").innerHTML = `<div class="card">` +
    pending.map((it, i) => {
      const [y, m] = ymOf(it);
      return `<div class="file" data-i="${i}">
        <div class="file-head"><span>${esc(it.file.name)}</span><button class="icon" data-act="remove">✕</button></div>
        <div class="row">
          <input type="month" value="${it.ym}" data-act="month" />
          <span class="muted">→ ${periodName(periodOf(y, m))} / ${esc(fileNameFor(y, m, it.ext))}${it.count != null ? `（${it.count}件）` : ""}</span>
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
$("#pending").addEventListener("click", (e) => {
  if (e.target.dataset.act !== "remove") return;
  pending.splice(e.target.closest(".file").dataset.i, 1);
  renderPending();
});

// ドライブへ：口座フォルダ / 第N期（なければ作る） / R8/8.csv
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
    const folder = await drive.findOrCreateFolder(acc.id, periodName(periodOf(y, m)));
    await drive.uploadFile(folder, fileNameFor(y, m, it.ext), new Blob([it.buffer], { type: it.file.type || "text/csv" }));
    pending.shift();
    renderPending();
  }
  toast(`${acc.name} に保存しました`);
};

// ---------- 確認（保存状況と合計） ----------
const cur = currentPeriod();
for (let n = cur; n >= Math.max(1, cur - 5); n--) {
  $("#period").insertAdjacentHTML("beforeend", `<option value="${n}">${periodLabel(n)}</option>`);
}

// 口座の「第N期」フォルダ内のファイル（「第３期＿済」のような名前にも対応）
async function filesInPeriod(acc, n) {
  const half = (s) => s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const folder = (await drive.listChildren(acc.id, { foldersOnly: true }))
    .find((f) => new RegExp(`^${periodName(n)}(?!\\d)`).test(half(f.name)));
  if (!folder) return { folderId: null, files: [] };
  return { folderId: folder.id, files: (await drive.listChildren(folder.id)).filter((f) => !f.mimeType.includes("folder")) };
}

let allTx = [];
$("#checkBtn").addEventListener("click", safe(async () => {
  await requireLogin();
  const n = Number($("#period").value);
  const months = monthsOfPeriod(n);
  const now = new Date();
  $("#checkResult").innerHTML = `<div class="card muted">読み込み中…</div>`;
  allTx = [];

  // 口座ごとに「保存済みの月」を調べ、CSVの中身は取引一覧用に読み込む
  const rows = await Promise.all(active().map(async (acc) => {
    const saved = new Map(); // "2026-8" → ファイルのURL
    const { folderId, files } = await filesInPeriod(acc, n);
    for (const f of files) {
      const fm = guessMonthFromName(f.name);
      if (fm) saved.set(`${fm.year}-${fm.month}`, f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`);
      if (/csv|text/.test(f.mimeType) || /\.csv$/i.test(f.name)) {
        const tx = parseStatement(await drive.downloadFile(f.id), acc.kind).transactions;
        allTx.push(...tx.map((t) => ({ ...t, account: acc.name })));
      }
    }
    return { acc, saved, folderId };
  }));
  allTx.sort((a, b) => a.date - b.date);

  const cell = (saved, m) => {
    const url = saved.get(`${m.year}-${m.month}`);
    if (url) return `<td class="ok">${extLink(url, "✓")}</td>`; // ✓を押すとそのファイルが開く
    return new Date(m.year, m.month - 1) > now ? `<td></td>` : `<td class="missing">−</td>`;
  };
  $("#checkResult").innerHTML = `
    <div class="card scroll">
      <table class="grid">
        <thead><tr><th></th>${months.map((m) => `<th>${m.month}月</th>`).join("")}</tr></thead>
        <tbody>${rows.map(({ acc, saved, folderId }) =>
          `<tr><th>${extLink(folderUrl(folderId || acc.id), esc(acc.name))}</th>${months.map((m) => cell(saved, m)).join("")}</tr>`).join("")}</tbody>
      </table>
      <p class="muted">✓ 保存済み　− 未保存（口座名や ✓ を押すとドライブが開きます）</p>
    </div>
    <div class="card">
      <div class="row">
        <input id="search" type="search" placeholder="取引を検索（例：AMAZON）" />
        <button id="exportBtn" class="btn ghost">CSV</button>
      </div>
      <div id="txList"></div>
    </div>`;
  renderTx();
  $("#search").addEventListener("input", renderTx);
  $("#exportBtn").addEventListener("click", () => exportCsv(n));
}));

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
  await drive.createFolder(CFG.ACCOUNT_GROUPS[$("#newKind").value].folderId, name, url ? urlToProps(url) : {});
  e.target.reset();
  await loadAccounts();
  toast(`「${name}」を追加しました`);
}));

$("#showClosed").addEventListener("change", renderAccountList);

function renderAccountList() {
  const show = $("#showClosed").checked;
  const list = accounts.filter((a) => show || !a.closed);
  $("#accountList").innerHTML = list.map((a) => `
    <div class="acct ${a.closed ? "closed" : ""}" data-id="${a.id}">
      <div>
        <span>${esc(a.name)}</span>
        <small class="acct-url">${linkFor(a) ? `<a href="${esc(linkFor(a))}" target="_blank" rel="noopener">明細ページ</a>${a.ownUrl ? "" : "（自動）"}` : "URL未設定"}</small>
      </div>
      <div class="acct-actions">
        <button class="btn small ghost" data-act="url">URL</button>
        ${a.closedByName ? `<small>名前で解約済み</small>`
          : `<button class="btn small ghost" data-act="${a.closed ? "reopen" : "close"}">${a.closed ? "戻す" : "解約"}</button>`}
      </div>
    </div>`).join("");
}

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
    // 同じバージョンへの読み込み直しは1回だけ（反映が遅れたときに何度も再読み込みしないように）
    if (sessionStorage.getItem("reloadedFor") === latest) return;
    sessionStorage.setItem("reloadedFor", latest);
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
  if (files.length) addFiles(files);
}

// ---------- ドライブへの直リンク ----------
function showDriveLinks() {
  if (!CFG.ROOT_FOLDER_ID) {
    $("#driveLink").href = "https://drive.google.com/";
    $("#driveLinks").textContent = "ログインすると表示されます";
    return;
  }
  $("#driveLink").href = folderUrl(CFG.ROOT_FOLDER_ID);
  $("#driveLinks").innerHTML = [{ label: "明細フォルダ（全体）", folderId: CFG.ROOT_FOLDER_ID }, ...CFG.ACCOUNT_GROUPS]
    .map((g) => `<div>${extLink(folderUrl(g.folderId), "📁 " + esc(g.label))}</div>`).join("");
}

// ---------- 起動 ----------
// 前回の口座一覧をすぐ表示 → 通行証が有効ならドライブから最新に更新
$("#appVersion").textContent = `バージョン ${window.APP_VERSION}`;
$("#headerVersion").textContent = `v${window.APP_VERSION}`;
updateAuthBtn();
showDriveLinks();
if (drive.hasLoggedIn()) {
  try { applyFolderIds(JSON.parse(localStorage.getItem("folderIds") || "{}")); } catch {}
  try { setAccounts(JSON.parse(localStorage.getItem("accounts") || "[]")); } catch {}
  if (drive.isSignedIn()) safe(loadAccounts)();
}
receiveShared();
if (!drive.getClientId()) {
  $("#googleCard").open = true;
  document.querySelector('[data-tab="settings"]').click();
}
