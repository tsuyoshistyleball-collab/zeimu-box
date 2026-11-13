// =============================================================
// 設定ファイル（ここを書き換えればアプリの動きを変えられます）
// ※ このファイルは公開されるので、IDやメールアドレスなどの個人情報は書かないこと
// =============================================================
window.APP_CONFIG = {
  // Google Cloud で作った「OAuth クライアントID」は、アプリの「設定」画面から入力します。
  GOOGLE_CLIENT_ID: "",

  // 明細を入れるGoogleドライブのフォルダを「名前」で指定します。
  // ログインすると、アプリがこの名前のフォルダを自分のドライブから探します（IDはコードに書かない）。
  ROOT_FOLDER_NAME: "銀行、クレカ明細",

  // 口座・カードのフォルダが並んでいる場所（マイドライブからのフォルダ名のつながり）。
  // アプリはここにある「フォルダ」を口座・カードの一覧として読み込みます。
  //  keepFileName: true … ファイル名を「R8/8」に変えず、元の名前のまま保存（名前は保存前に編集できる）
  //  expandSubfolders: true … 中がさらに分かれているフォルダ（例：auPAYマーケット）は、その中も一覧に出す
  ACCOUNT_GROUPS: [
    { kind: "bank", label: "銀行（仕事で使用）", path: ["銀行、クレカ明細", "銀行入出金明細", "仕事で使用"] },
    { kind: "card", label: "クレジットカード（仕事で使用）", path: ["銀行、クレカ明細", "クレジットカード支払い明細", "仕事で使用"] },
    { kind: "sales", label: "売上振込", path: ["売上振込Amazon、ヤフー、メルカリ、au"], keepFileName: true, expandSubfolders: true },
  ],

  // 決算期の設定：第6期 = 2025年8月〜2026年7月 なので
  // 「期首の月 = 8月」「第1期が始まった年 = 2020年」
  FISCAL_START_MONTH: 8,
  FIRST_PERIOD_START_YEAR: 2020,

  // ファイル名の形式（例：R8/8.csv ＝ 令和8年8月）
  // {r} = 令和の年, {y} = 西暦, {m} = 月, {mm} = 2桁の月, {ext} = 拡張子
  FILE_NAME_FORMAT: "R{r}/{m}.{ext}",

  // 売上振込のフォルダ名にこの文字が含まれていたら、このページを「明細ページを開く」の行き先にします。
  SALES_LINKS: {
    "Amazon": "https://sellercentral.amazon.co.jp/amazonsell/payments",
  },

  // 口座名にこの文字が含まれていたら「明細ページを開く」リンクを出します（一般的な金融機関の一覧）。
  // 個別に設定したい場合は、口座を追加するときにURLを入れてください（ドライブ側に保存されます）。
  LOGIN_LINKS: {
    "三菱UFJ": "https://www.bk.mufg.jp/",
    "三井住友銀行": "https://www.smbc.co.jp/",
    "みずほ": "https://www.mizuhobank.co.jp/",
    "りそな": "https://www.resonabank.co.jp/",
    "ゆうちょ": "https://www.jp-bank.japanpost.jp/",
    "楽天銀行": "https://www.rakuten-bank.co.jp/",
    "住信SBI": "https://www.netbk.co.jp/",
    "PayPay銀行": "https://www.paypay-bank.co.jp/",
    "ソニー銀行": "https://sonybank.net/",
    "auじぶん銀行": "https://www.jibunbank.co.jp/",
    "GMOあおぞら": "https://gmo-aozora.com/",
    "イオン銀行": "https://www.aeonbank.co.jp/",
    "横浜銀行": "https://www.boy.co.jp/",
    "楽天": "https://www.rakuten-card.co.jp/e-navi/",
    "三井住友カード": "https://www.smbc-card.com/",
    "AMEX": "https://www.americanexpress.com/ja-jp/account/login",
    "アメックス": "https://www.americanexpress.com/ja-jp/account/login",
    "JCB": "https://my.jcb.co.jp/",
    "セゾン": "https://www.saisoncard.co.jp/",
    "イオンカード": "https://www.aeon.co.jp/",
    "dカード": "https://dcard.docomo.ne.jp/",
    "PayPay": "https://www.paypay-card.co.jp/",
    "ヤフーカード": "https://www.paypay-card.co.jp/",
    "エポス": "https://www.eposcard.co.jp/",
    "オリコ": "https://www.orico.co.jp/",
    "UCS": "https://www.ucscard.co.jp/",
    "TSカード": "https://tscubic.com/",
    "レクサス": "https://tscubic.com/",
    "UPSIDER": "https://up-sider.com/",
    "バクラク": "https://bakuraku.jp/",
    "PayPal": "https://www.paypal.com/jp/signin",
    "Amazon": "https://www.amazon.co.jp/",
  },
};
