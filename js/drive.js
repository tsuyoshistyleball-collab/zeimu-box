// =============================================================
// Googleログイン と Googleドライブ操作
//  - Google Identity Services（GIS）でログインして「アクセストークン」をもらう
//  - そのトークンを付けて Drive API（https://www.googleapis.com/drive/v3）を呼ぶ
// =============================================================
const SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

// ログイン状態は端末（localStorage）に保存するので、アプリを更新・再起動しても消えません。
// Googleの決まりで「通行証（アクセストークン）」は約1時間で切れますが、
// 一度ログインしていれば、次にボタンを押したとき自動で取り直します（アカウント選択なし）。
let accessToken = localStorage.getItem("token") || null;
let tokenExpiresAt = Number(localStorage.getItem("tokenExpiresAt") || 0);

export function getClientId() {
  return localStorage.getItem("clientId") || window.APP_CONFIG.GOOGLE_CLIENT_ID || "";
}

// 通行証が今使える状態か
export function isSignedIn() {
  return !!accessToken && Date.now() < tokenExpiresAt;
}

// 過去にログインしたことがあるか（＝ログイン中として扱う）
export function hasLoggedIn() {
  return localStorage.getItem("loggedIn") === "1";
}

// Googleのログイン用スクリプトが読み込まれるまで待つ
function waitForGis() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - start > 10000) return reject(new Error("Googleログイン部品を読み込めませんでした（通信を確認してください）"));
      setTimeout(check, 100);
    })();
  });
}

// ログイン。2回目以降は prompt:"" と login_hint で、選択画面なしに自動で通行証を取り直す。
export async function signIn() {
  const clientId = getClientId();
  if (!clientId) throw new Error("設定画面で Google クライアントID を入力してください");
  await waitForGis();
  const again = hasLoggedIn();
  await new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      login_hint: localStorage.getItem("email") || undefined,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in) - 60) * 1000;
        localStorage.setItem("token", accessToken);
        localStorage.setItem("tokenExpiresAt", String(tokenExpiresAt));
        localStorage.setItem("loggedIn", "1");
        resolve();
      },
      error_callback: (err) => reject(new Error(err.message || "ログインがキャンセルされました")),
    });
    client.requestAccessToken(again ? { prompt: "" } : {});
  });
  // 次回の自動ログイン用に、メールアドレスを覚えておく
  if (!localStorage.getItem("email")) {
    const res = await fetch(`${API}/about?fields=user(emailAddress)`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.ok) localStorage.setItem("email", (await res.json()).user.emailAddress);
  }
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(accessToken);
  accessToken = null;
  tokenExpiresAt = 0;
  for (const k of ["token", "tokenExpiresAt", "loggedIn", "email", "accounts", "folderIds"]) localStorage.removeItem(k);
}

async function ensureToken() {
  if (!isSignedIn()) await signIn();
}

// Drive API を呼ぶ共通関数
async function api(url, options = {}) {
  await ensureToken();
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
  });
  if (res.status === 401 && !options._retried) {
    tokenExpiresAt = 0;
    return api(url, { ...options, _retried: true });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API エラー (${res.status}): ${text.slice(0, 200)}`);
  }
  return res;
}

const q = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// フォルダの中身を一覧
export async function listChildren(folderId, { foldersOnly = false } = {}) {
  let query = `'${folderId}' in parents and trashed = false`;
  if (foldersOnly) query += ` and mimeType = '${FOLDER_MIME}'`;
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: query,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink, description, appProperties)",
      pageSize: "200",
      orderBy: "name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await api(`${API}/files?${params}`)).json();
    files.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

// 名前のつながり（例：["銀行、クレカ明細","銀行入出金明細","仕事で使用"]）でフォルダを探してIDを返す。
// フォルダIDをコードに書かずに済むように、ログイン後にドライブから探します。
export async function findFolderByPath(names) {
  const params = new URLSearchParams({
    q: `name = '${q(names[0])}' and mimeType = '${FOLDER_MIME}' and trashed = false and 'me' in owners`,
    fields: "files(id)",
  });
  let id = (await (await api(`${API}/files?${params}`)).json()).files[0]?.id;
  for (const name of names.slice(1)) {
    if (!id) break;
    id = (await listChildren(id, { foldersOnly: true })).find((f) => f.name === name)?.id;
  }
  if (!id) throw new Error(`ドライブに「${names.join(" / ")}」フォルダが見つかりません`);
  return id;
}

// 名前でフォルダを探し、なければ作る（例：「第7期」）
export async function findOrCreateFolder(parentId, name) {
  const params = new URLSearchParams({
    q: `'${parentId}' in parents and name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id, name)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const data = await (await api(`${API}/files?${params}`)).json();
  if (data.files.length) return data.files[0].id;
  const res = await api(`${API}/files?supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return (await res.json()).id;
}

// ファイルをアップロード（同じ名前があれば上書き＝新しい版として保存）
export async function uploadFile(parentId, name, blob) {
  const params = new URLSearchParams({
    q: `'${parentId}' in parents and name = '${q(name)}' and trashed = false`,
    fields: "files(id)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const existing = (await (await api(`${API}/files?${params}`)).json()).files[0];

  const metadata = existing ? { name } : { name, parents: [parentId] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);

  const url = existing
    ? `${UPLOAD_API}/files/${existing.id}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`
    : `${UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`;
  const res = await api(url, { method: existing ? "PATCH" : "POST", body: form });
  return { ...(await res.json()), replaced: !!existing };
}

// 新しいフォルダを作る（口座・カードの追加用）。appProperties（見えない印）も一緒に付けられる
export async function createFolder(parentId, name, appProperties = {}) {
  const res = await api(`${API}/files?supportsAllDrives=true&fields=id,name`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, appProperties, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return await res.json();
}

// ファイル・フォルダの情報を変える（このアプリでは名前は変えず、見えない印 appProperties だけを使う）
export async function updateMetadata(fileId, changes) {
  const res = await api(`${API}/files/${fileId}?supportsAllDrives=true&fields=id,name,description`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  return await res.json();
}

// ファイルの中身をダウンロード（集計用）
export async function downloadFile(fileId) {
  const res = await api(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`);
  return await res.arrayBuffer();
}
