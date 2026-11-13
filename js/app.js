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
  $("#pending").innerHTML = `<div class="card">` +
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
};

// ---------- 確認（保存状況と合計） ----------
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

let allTx = [];

// − ⇄ △ の切り替え（押したらすぐ表示を変え、ドライブの見えない印にも保存する）
$("#checkResult").addEventListener("click", safe(async (e) => {
  const td = e.target.closest("td.toggle");
  if (!td) return;
  const acc = accounts.find((a) => a.id === td.dataset.acc);
  const n = $("#period").value, month = Number(td.dataset.month);
  const list = new Set(acc.na?.[n] || []);
  const toNa = !list.has(month);
  toNa ? list.add(month) : list.delete(month);
  const show = (na) => { td.textContent = na ? "△" : "−"; td.className = (na ? "na" : "missing") + " toggle"; };
  show(toNa);
  try {
    await drive.updateMetadata(acc.id, { appProperties: { ["na" + n]: [...list].join(",") || null } });
  } catch (err) {
    show(!toNa); // 保存できなかったら表示を元に戻す
    throw err;
  }
  acc.na = { ...acc.na, [n]: [...list] };
  // 端末に覚えている一覧にも反映
  const cache = JSON.parse(localStorage.getItem("accounts") || "[]");
  const c = cache.find((a) => a.id === acc.id);
  if (c) { c.na = acc.na; localStorage.setItem("accounts", JSON.stringify(cache)); }
}));
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
      const fm = monthOfFile(f, months);
      if (fm?.year) saved.set(`${fm.year}-${fm.month}`, f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`);
      if (/csv|text/.test(f.mimeType) || /\.csv$/i.test(f.name)) {
        const tx = parseStatement(await drive.downloadFile(f.id), acc.kind).transactions;
        allTx.push(...tx.map((t) => ({ ...t, account: acc.name })));
      }
    }
    return { acc, saved, folderId };
  }));
  allTx.sort((a, b) => a.date - b.date);

  const cell = (acc, saved, m) => {
    const url = saved.get(`${m.year}-${m.month}`);
    if (url) return `<td class="ok">${extLink(url, "✓")}</td>`; // ✓を押すとそのファイルが開く
    if (new Date(m.year, m.month - 1) > now) return `<td></td>`;
    // − と △ は押すと切り替わる（△＝その月は明細がそもそも無い）
    const na = acc.na?.[n]?.includes(m.month);
    return `<td class="${na ? "na" : "missing"} toggle" data-acc="${acc.id}" data-month="${m.month}" title="押すと − と △ を切り替え">${na ? "△" : "−"}</td>`;
  };
  $("#checkResult").innerHTML = `
    <div class="card scroll">
      <table class="grid">
        <thead><tr><th></th>${months.map((m) => `<th>${m.month}月</th>`).join("")}</tr></thead>
        <tbody>${rows.map(({ acc, saved, folderId }) =>
          `<tr><th>${extLink(folderUrl(folderId || acc.id), esc(acc.name))}</th>${months.map((m) => cell(acc, saved, m)).join("")}</tr>`).join("")}</tbody>
      </table>
      <p class="muted">✓ 保存済み　− 未保存　△ 明細なし<br><b>− を押すと △（その月は明細が無い）に変えられます。</b>もう一度押すと − に戻ります。<br>口座名や ✓ を押すとドライブが開きます。</p>
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
  if (files.length) addFiles(files);
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
  if (drive.isSignedIn()) safe(loadAccounts)();
  showListStatus();
}
receiveShared();
if (!drive.getClientId()) {
  $("#googleCard").open = true;
  document.querySelector('[data-tab="settings"]').click();
}
