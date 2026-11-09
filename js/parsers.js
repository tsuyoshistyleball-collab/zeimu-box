// =============================================================
// 明細ファイル（CSV）を読み取る処理
//  - 銀行のCSVは Shift_JIS、カードのCSVは UTF-8 のことが多いので両方に対応
//  - 列名（「利用日」「入出金」など）から日付・金額・内容の列を自動で見つける
// =============================================================

// 文字コードを判定して文字列にする
export function decodeText(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(buffer);
  }
}

// CSVを「行×列」の配列にする（"..." の中のカンマや改行にも対応）
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row.map((v) => v.trim()));
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row.map((v) => v.trim()));
  return rows;
}

// "2026/07/30" "20260730" "2026-7-3" "2026年7月3日" などを Date に
export function parseDate(s) {
  if (!s) return null;
  s = s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).trim();
  let m = s.match(/^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d) ? null : d;
}

export function parseAmount(s) {
  if (s == null) return null;
  const t = String(s).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[,¥￥円\s]/g, "").replace(/^▲|^△/, "-");
  if (t === "" || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const has = (h, words) => words.some((w) => h.includes(w));

// 見出し行を探し、どの列が「日付・金額・内容」かを判定
function detectColumns(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const header = rows[r];
    const idx = (words, exclude = []) =>
      header.findIndex((h) => has(h, words) && !has(h, exclude));
    const date = idx(["利用日", "取引日", "日付", "年月日", "ご利用日", "お取引日", "Date", "日"], ["支払日"]);
    if (date === -1) continue;
    const desc = idx(["利用店名", "店名", "内容", "摘要", "入出金先", "ご利用先", "取引内容", "明細", "Description"]);
    const signed = idx(["入出金"], ["先", "内容"]);
    const deposit = idx(["入金", "お預入", "預入", "お預り"], ["出金"]);
    const withdraw = idx(["出金", "お引出", "引出", "お支払"], ["入金"]);
    const amount = idx(["利用金額", "ご利用金額", "金額", "Amount"], ["手数料", "支払総額", "繰越", "残高"]);
    const balance = idx(["残高"], ["繰越"]);
    return { headerRow: r, date, desc, signed, deposit, withdraw, amount, balance };
  }
  return null;
}

// CSV → 取引の配列 [{date, desc, amount(+入金/-出金・支払)}]
// kind: "bank" | "card"
export function parseStatement(buffer, kind) {
  const text = decodeText(buffer);
  const rows = parseCsv(text);
  const cols = detectColumns(rows);
  const result = { text, rows, cols, transactions: [], header: cols ? rows[cols.headerRow] : null };

  // 見出しが無いCSV：1列目が日付なら「日付, 金額, 残高, 内容」の形とみなす
  const startRow = cols ? cols.headerRow + 1 : 0;
  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r];
    let date, desc = "", amount = null;
    if (cols) {
      date = parseDate(row[cols.date]);
      if (cols.desc >= 0) desc = row[cols.desc] || "";
      if (cols.signed >= 0) amount = parseAmount(row[cols.signed]);
      else if (cols.deposit >= 0 || cols.withdraw >= 0) {
        const dep = parseAmount(row[cols.deposit]) || 0;
        const wd = parseAmount(row[cols.withdraw]) || 0;
        amount = dep - wd;
      } else if (cols.amount >= 0) {
        const a = parseAmount(row[cols.amount]);
        amount = a == null ? null : kind === "card" ? -a : a;
      }
    } else {
      date = parseDate(row[0]);
      amount = parseAmount(row[1]);
      desc = row.slice(2).find((v) => v && parseAmount(v) == null) || "";
    }
    if (!date || amount == null) continue;
    result.transactions.push({ date, desc, amount });
  }

  // カードの「8月支払金額」のような見出しから支払月を読み取る
  if (result.header) {
    const h = result.header.find((x) => /(\d{1,2})月支払/.test(x));
    if (h) result.billingMonth = Number(h.match(/(\d{1,2})月支払/)[1]);
  }
  return result;
}

// 明細から「何年何月の分か」を推測する
//  銀行：取引が一番多い月
//  カード：見出しの「◯月支払」→ なければ最後の利用月の翌月（＝支払月）
export function guessMonth(parsed, kind) {
  const tx = parsed.transactions;
  if (!tx.length) return null;
  const latest = tx.reduce((a, b) => (a.date > b.date ? a : b)).date;
  if (kind === "card") {
    if (parsed.billingMonth) {
      let y = latest.getFullYear();
      if (parsed.billingMonth < latest.getMonth() + 1) y++; // 12月利用→1月支払
      return { year: y, month: parsed.billingMonth };
    }
    const d = new Date(latest.getFullYear(), latest.getMonth() + 1, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  const count = {};
  for (const t of tx) {
    const k = `${t.date.getFullYear()}-${t.date.getMonth() + 1}`;
    count[k] = (count[k] || 0) + 1;
  }
  const [y, m] = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0].split("-").map(Number);
  return { year: y, month: m };
}

// ファイル名から月を推測
//  「R8/8.csv」→ 2026年8月　「2025/10/13 - 2025/10/20.pdf」→ 2025年10月
//  「202608.csv」→ 2026年8月　「08/12振込予定」→ 8月（年は不明なので year: null）
export function guessMonthFromName(name) {
  name = name.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const ok = (m) => m >= 1 && m <= 12;
  let m = name.match(/R(\d{1,2})[\/_\-年.](\d{1,2})(?!\d)/i);
  if (m && ok(+m[2])) return { year: 2018 + Number(m[1]), month: Number(m[2]) };
  m = name.match(/(20\d{2})[\/_\-年.](\d{1,2})(?!\d)/);
  if (m && ok(+m[2])) return { year: Number(m[1]), month: Number(m[2]) };
  m = name.match(/(20\d{2})(\d{2})/);
  if (m && ok(+m[2])) return { year: Number(m[1]), month: Number(m[2]) };
  m = name.match(/^(\d{1,2})[\/月](\d{1,2})/);
  if (m && ok(+m[1])) return { year: null, month: Number(m[1]) };
  return null;
}
