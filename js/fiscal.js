// =============================================================
// 決算期（第N期）や和暦ファイル名の計算
// =============================================================
const C = () => window.APP_CONFIG;

// 年月 → 第何期か
export function periodOf(year, month) {
  const startYear = month >= C().FISCAL_START_MONTH ? year : year - 1;
  return startYear - C().FIRST_PERIOD_START_YEAR + 1;
}

export function periodName(n) {
  return `第${n}期`;
}

// 第N期に含まれる12か月 [{year, month}, ...]
export function monthsOfPeriod(n) {
  const startYear = C().FIRST_PERIOD_START_YEAR + n - 1;
  const list = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(startYear, C().FISCAL_START_MONTH - 1 + i, 1);
    list.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return list;
}

export function periodLabel(n) {
  const ms = monthsOfPeriod(n);
  const a = ms[0], b = ms[11];
  return `${periodName(n)}（${a.year}/${a.month}〜${b.year}/${b.month}）`;
}

export function currentPeriod() {
  const now = new Date();
  return periodOf(now.getFullYear(), now.getMonth() + 1);
}

export function reiwa(year) {
  return year - 2018;
}

// 保存するファイル名（例：R8/8.csv）
export function fileNameFor(year, month, ext) {
  return C().FILE_NAME_FORMAT
    .replace("{r}", reiwa(year))
    .replace("{y}", year)
    .replace("{m}", month)
    .replace("{mm}", String(month).padStart(2, "0"))
    .replace("{ext}", ext || "csv");
}
