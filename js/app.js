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
      list.push({ id: f.id, name: f.name, kind: g.kind, groupId: g.folderId, url: f.description || "" });
    }
  }
  localStorage.setItem("accounts", JSON.stringify(list));
  setAccounts(list);
}

function setAccounts(list) {
  accounts = list
    .map((a) => ({ ...a, group: CFG.ACCOUNT_GROUPS.find((g) => g.folderId === a.groupId), closed: CLOSED.test(a.name) }))
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
const saveAll = safe(async () => {
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
});

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
  if (url && !/^https?:\/\//.test(url)) return toast("URLは https:// から入れてください", true);
  await requireLogin();
  await drive.createFolder(CFG.ACCOUNT_GROUPS[$("#newKind").value].folderId, name, url);
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
      <span>${esc(a.name)}</span>
      <button class="btn small ghost" data-act="${a.closed ? "reopen" : "close"}">${a.closed ? "戻す" : "解約"}</button>
    </div>`).join("");
}

// 解約＝フォルダ名に【解約】を付けるだけ（保存済みの明細は消えない）
$("#accountList").addEventListener("click", safe(async (e) => {
  const acc = accounts.find((a) => a.id === e.target.closest(".acct")?.dataset.id);
  const act = e.target.dataset.act;
  if (!acc || !act) return;
  if (act === "close") {
    if (!confirm(`「${acc.name}」を解約済みにしますか？（明細は消えません）`)) return;
    await drive.updateMetadata(acc.id, { name: "【解約】" + acc.name });
  } else {
    await drive.updateMetadata(acc.id, { name: acc.name.replace(CLOSED, "") });
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
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });

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
