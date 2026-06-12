import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import * as zlib from "zlib";
import * as http from "http";
import { exec, spawn } from "child_process";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

// Constant keys and parameters
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_PORT = 1455;
const EXPIRY_SKEW_SECONDS = 60;

const SLIM_EXPORT_PREFIX = "css1.";
const SLIM_FORMAT_VERSION = 1;
const SLIM_AUTH_API_KEY = 0;
const SLIM_AUTH_CHATGPT = 1;

const FULL_FILE_MAGIC = "CSWF";
const FULL_FILE_VERSION = 1;
const FULL_SALT_LEN = 16;
const FULL_NONCE_LEN = 24;
const FULL_KDF_ITERATIONS = 210000;
const FULL_PRESET_PASSPHRASE = "gT7kQ9mV2xN4pL8sR1dH6zW3cB5yF0uJ_aE7nK2tP9vM4rX1";

const MAX_IMPORT_JSON_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = 8 * 1024 * 1024;
const SLIM_IMPORT_CONCURRENCY = 6;

const CHATGPT_BACKEND_API = "https://chatgpt.com/backend-api";
const CHATGPT_ACCOUNTS_CHECK_API = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const CHATGPT_CODEX_RESPONSES_API = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_API = "https://api.openai.com/v1";
const CODEX_USER_AGENT = "codex-cli/1.0.0";

const CODEX_RUNNING_SWITCH_BLOCKED_PREFIX = "Cannot switch accounts while ";

// Core Types
export interface StoredAccount {
  id: string;
  name: string;
  email: string | null;
  plan_type: string | null;
  subscription_expires_at: string | null; // ISO string
  auth_mode: "api_key" | "chatgpt";
  auth_data: {
    type: "api_key" | "chatgpt";
    key?: string;
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string | null;
  };
  created_at: string; // ISO string
  last_used_at: string | null; // ISO string
}

export interface AccountsStore {
  version: number;
  accounts: StoredAccount[];
  active_account_id: string | null;
  masked_account_ids: string[];
}

export interface AccountInfo {
  id: string;
  name: string;
  email: string | null;
  plan_type: string | null;
  subscription_expires_at: string | null;
  auth_mode: "api_key" | "chatgpt";
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface UsageInfo {
  account_id: string;
  plan_type: string | null;
  primary_used_percent: number | null;
  primary_window_minutes: number | null;
  primary_resets_at: number | null;
  secondary_used_percent: number | null;
  secondary_window_minutes: number | null;
  secondary_resets_at: number | null;
  has_credits: boolean | null;
  unlimited_credits: boolean | null;
  credits_balance: string | null;
  error: string | null;
}

export interface WarmupSummary {
  total_accounts: number;
  warmed_accounts: number;
  failed_account_ids: string[];
}

export interface ImportAccountsSummary {
  total_in_payload: number;
  imported_count: number;
  skipped_count: number;
}

export interface CodexProcessInfo {
  count: number;
  background_count: number;
  can_switch: boolean;
  pids: number[];
}

export interface KillCodexProcessesResult {
  targeted_count: number;
  killed_pids: number[];
  failed_pids: number[];
}

// Helpers for paths
export function getCodexHome(): string {
  if (process.env.CODEX_HOME) {
    return process.env.CODEX_HOME;
  }
  return path.join(os.homedir(), ".codex");
}

export function getCodexAuthFile(): string {
  return path.join(getCodexHome(), "auth.json");
}

export function getConfigDir(): string {
  return path.join(os.homedir(), ".codex-switcher");
}

export function getAccountsFile(): string {
  return path.join(getConfigDir(), "accounts.json");
}

// Storage operations
export function loadAccounts(): AccountsStore {
  const filePath = getAccountsFile();
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      accounts: [],
      active_account_id: null,
      masked_account_ids: []
    };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      accounts: parsed.accounts || [],
      active_account_id: parsed.active_account_id || null,
      masked_account_ids: parsed.masked_account_ids || []
    };
  } catch (e) {
    console.error("Failed to parse accounts file, returning default", e);
    return {
      version: 1,
      accounts: [],
      active_account_id: null,
      masked_account_ids: []
    };
  }
}

export function saveAccounts(store: AccountsStore): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const filePath = getAccountsFile();
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");

  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (e) {
      console.error("Failed to set chmod on accounts.json", e);
    }
  }
}

export function getAccountInfo(account: StoredAccount, activeId: string | null): AccountInfo {
  let subExpires: string | null = account.subscription_expires_at;
  if (!subExpires && account.auth_mode === "chatgpt" && account.auth_data.id_token) {
    const claims = parseChatGptIdTokenClaims(account.auth_data.id_token);
    subExpires = claims.subscription_expires_at;
  }

  return {
    id: account.id,
    name: account.name,
    email: account.email,
    plan_type: account.plan_type,
    subscription_expires_at: subExpires,
    auth_mode: account.auth_mode,
    is_active: account.id === activeId,
    created_at: account.created_at,
    last_used_at: account.last_used_at
  };
}

// JWT Token Parser
export interface ChatGptIdTokenClaims {
  email: string | null;
  plan_type: string | null;
  account_id: string | null;
  subscription_expires_at: string | null;
}

export function parseChatGptIdTokenClaims(idToken: string): ChatGptIdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    return { email: null, plan_type: null, account_id: null, subscription_expires_at: null };
  }

  try {
    const payloadBuffer = Buffer.from(parts[1], "base64url");
    const json = JSON.parse(payloadBuffer.toString("utf-8"));
    const authClaims = json["https://api.openai.com/auth"] || {};

    return {
      email: json.email || null,
      plan_type: authClaims.chatgpt_plan_type || null,
      account_id: authClaims.chatgpt_account_id || null,
      subscription_expires_at: authClaims.chatgpt_subscription_active_until || null
    };
  } catch (e) {
    console.error("Failed to parse JWT id token", e);
    return { email: null, plan_type: null, account_id: null, subscription_expires_at: null };
  }
}

// Token Expiry / Refresh Helper
function tokenExpiredOrNearExpiry(accessToken: string): boolean {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return true;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    if (typeof payload.exp !== "number") return true;

    const nowSeconds = Math.floor(Date.now() / 1000);
    return payload.exp <= nowSeconds + EXPIRY_SKEW_SECONDS;
  } catch {
    return true;
  }
}

async function refreshChatGptTokens(account: StoredAccount): Promise<StoredAccount> {
  if (account.auth_mode !== "chatgpt" || !account.auth_data.refresh_token) {
    return account;
  }

  const refreshToken = account.auth_data.refresh_token;
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${CLIENT_ID}`;

  let response: Response | null = null;
  let lastError: any = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${DEFAULT_ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (res.ok) {
        response = res;
        break;
      }
      const text = await res.text();
      lastError = new Error(`HTTP ${res.status}: ${text}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }

  if (!response) {
    throw lastError || new Error("Failed to send token refresh request");
  }

  const data = await response.json() as { id_token?: string; access_token: string; refresh_token?: string };
  const nextIdToken = data.id_token || account.auth_data.id_token || "";
  const nextRefreshToken = data.refresh_token || refreshToken;

  const claims = parseChatGptIdTokenClaims(nextIdToken);
  const nextAccountId = claims.account_id || account.auth_data.account_id || null;

  // Update store
  const store = loadAccounts();
  const index = store.accounts.findIndex(a => a.id === account.id);
  if (index === -1) {
    throw new Error(`Account not found during token refresh: ${account.id}`);
  }

  const updated: StoredAccount = {
    ...store.accounts[index],
    email: claims.email || store.accounts[index].email,
    plan_type: claims.plan_type || store.accounts[index].plan_type,
    subscription_expires_at: claims.subscription_expires_at || store.accounts[index].subscription_expires_at,
    auth_data: {
      type: "chatgpt",
      id_token: nextIdToken,
      access_token: data.access_token,
      refresh_token: nextRefreshToken,
      account_id: nextAccountId
    }
  };

  store.accounts[index] = updated;
  saveAccounts(store);

  // Sync auth.json if active
  if (store.active_account_id === account.id) {
    try {
      syncToAuthJson(updated);
    } catch (e) {
      console.error("Failed to sync active auth.json after refresh", e);
    }
  }

  return updated;
}

export async function ensureChatGptTokensFresh(account: StoredAccount): Promise<StoredAccount> {
  if (account.auth_mode !== "chatgpt") return account;
  const accessToken = account.auth_data.access_token || "";

  if (tokenExpiredOrNearExpiry(accessToken)) {
    console.log(`[Auth] Access token expired/near expiry for account ${account.name}, refreshing`);
    return refreshChatGptTokens(account);
  }
  return account;
}

function syncToAuthJson(account: StoredAccount): void {
  const codexHome = getCodexHome();
  if (!fs.existsSync(codexHome)) {
    fs.mkdirSync(codexHome, { recursive: true });
  }

  const authFile = getCodexAuthFile();
  let content: any = {};

  if (account.auth_mode === "api_key" && account.auth_data.key) {
    content = {
      OPENAI_API_KEY: account.auth_data.key
    };
  } else if (account.auth_mode === "chatgpt" && account.auth_data.access_token) {
    content = {
      tokens: {
        id_token: account.auth_data.id_token,
        access_token: account.auth_data.access_token,
        refresh_token: account.auth_data.refresh_token,
        account_id: account.auth_data.account_id || undefined
      },
      last_refresh: new Date().toISOString()
    };
  } else {
    throw new Error("Invalid authentication credentials");
  }

  fs.writeFileSync(authFile, JSON.stringify(content, null, 2), "utf-8");

  if (process.platform !== "win32") {
    try {
      fs.chmodSync(authFile, 0o600);
    } catch (e) {
      console.error("Failed to set chmod 0600 on auth.json", e);
    }
  }
}

// RESTORE slim ChatGPT account from refresh token
async function createChatGptAccountFromRefreshToken(name: string, refreshToken: string): Promise<StoredAccount> {
  const mockAccount: StoredAccount = {
    id: crypto.randomUUID(),
    name,
    email: null,
    plan_type: null,
    subscription_expires_at: null,
    auth_mode: "chatgpt",
    auth_data: {
      type: "chatgpt",
      id_token: "",
      access_token: "",
      refresh_token: refreshToken,
      account_id: null
    },
    created_at: new Date().toISOString(),
    last_used_at: null
  };

  return refreshChatGptTokens(mockAccount);
}

function renderAuthPage(title: string, isSuccess: boolean, message: string, detail?: string): string {
  const iconSvg = isSuccess 
    ? `<svg class="status-svg success" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
    : `<svg class="status-svg error" viewBox="0 0 24 24" fill="none" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

  return `<!DOCTYPE html>
<html>
<head>
    <title>\${title}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background-color: #1e1e1e;
            color: #d4d4d4;
        }
        .container {
            text-align: center;
            background-color: #252526;
            border: 1px solid #2d2d2d;
            padding: 40px 50px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            max-width: 400px;
            width: 100%;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        .status-svg {
            width: 48px;
            height: 48px;
            margin-bottom: 20px;
        }
        h1 {
            color: #ffffff;
            font-size: 20px;
            font-weight: 600;
            margin: 0 0 10px 0;
        }
        p {
            color: #a6a6a6;
            font-size: 13px;
            line-height: 1.5;
            margin: 0;
        }
        .detail {
            margin-top: 15px;
            padding: 8px 12px;
            background-color: #1e1e1e;
            border: 1px solid #2d2d2d;
            border-radius: 6px;
            font-family: monospace;
            font-size: 11px;
            color: #ff4d4d;
            word-break: break-all;
            width: 100%;
            box-sizing: border-box;
        }
    </style>
</head>
<body>
    <div class="container">
        \${iconSvg}
        <h1>\${title}</h1>
        <p>\${message}</p>
        \${detail ? \`<div class="detail">\${detail}</div>\` : ""}
    </div>
</body>
</html>`;
}

// OAuth Callback server implementation
interface PendingOAuth {
  server: http.Server;
  cancelled: boolean;
  resolver: (value: any) => void;
  rejecter: (reason: any) => void;
}

let pendingOAuth: PendingOAuth | null = null;

export async function startLogin(accountName: string): Promise<{ auth_url: string; callback_port: number }> {
  // Cancel previous flow
  if (pendingOAuth) {
    pendingOAuth.cancelled = true;
    pendingOAuth.server.close();
    pendingOAuth.rejecter(new Error("Login cancelled by new request"));
    pendingOAuth = null;
  }

  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");

  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        // Fallback to random free port
        server.listen(0, "127.0.0.1");
      } else {
        reject(err);
      }
    });

    server.on("request", async (req, res) => {
      const urlObj = new URL(req.url || "", `http://${req.headers.host}`);
      if (urlObj.pathname === "/auth/callback") {
        const query = urlObj.searchParams;
        const code = query.get("code");
        const reqState = query.get("state");
        const error = query.get("error");
        const errorDesc = query.get("error_description");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAuthPage("Login Failed", false, "OAuth authorization error occurred.", `${error}: ${errorDesc}`));
          if (pendingOAuth && !pendingOAuth.cancelled) {
            pendingOAuth.rejecter(new Error(`OAuth error: ${error} - ${errorDesc}`));
          }
          server.close();
          return;
        }

        if (reqState !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAuthPage("Login Failed", false, "OAuth security state verification failed.", "State mismatch error"));
          if (pendingOAuth && !pendingOAuth.cancelled) {
            pendingOAuth.rejecter(new Error("OAuth state mismatch"));
          }
          server.close();
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAuthPage("Login Failed", false, "Authorization code was not returned.", "Missing authorization code"));
          if (pendingOAuth && !pendingOAuth.cancelled) {
            pendingOAuth.rejecter(new Error("Missing authorization code"));
          }
          server.close();
          return;
        }

        // Exchange code
        try {
          const actualPort = (server.address() as any).port;
          const redirectUri = `http://localhost:${actualPort}/auth/callback`;

          const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${CLIENT_ID}&code_verifier=${encodeURIComponent(verifier)}`;

          const tokenRes = await fetch(`${DEFAULT_ISSUER}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
          });

          if (!tokenRes.ok) {
            const bodyText = await tokenRes.text();
            throw new Error(`Token exchange failed: HTTP ${tokenRes.status} - ${bodyText}`);
          }

          const tokenData = await tokenRes.json() as { id_token: string; access_token: string; refresh_token: string };
          const claims = parseChatGptIdTokenClaims(tokenData.id_token);

          const account: StoredAccount = {
            id: crypto.randomUUID(),
            name: accountName,
            email: claims.email,
            plan_type: claims.plan_type,
            subscription_expires_at: claims.subscription_expires_at,
            auth_mode: "chatgpt",
            auth_data: {
              type: "chatgpt",
              id_token: tokenData.id_token,
              access_token: tokenData.access_token,
              refresh_token: tokenData.refresh_token,
              account_id: claims.account_id
            },
            created_at: new Date().toISOString(),
            last_used_at: null
          };

          // Render Success page
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAuthPage("Login Successful!", true, "You can close this window and return to Codex Switcher."));

          if (pendingOAuth && !pendingOAuth.cancelled) {
            pendingOAuth.resolver(account);
          }
          server.close();
        } catch (err: any) {
          console.error("Token exchange failed", err);
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAuthPage("Exchange Failed", false, "Failed to exchange authorization token.", err.message));
          if (pendingOAuth && !pendingOAuth.cancelled) {
            pendingOAuth.rejecter(err);
          }
          server.close();
        }
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.listen(DEFAULT_PORT, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      const redirectUri = `http://localhost:${port}/auth/callback`;
      const authUrl = `${DEFAULT_ISSUER}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("openid profile email offline_access")}&code_challenge=${challenge}&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=${state}&originator=codex_cli_rs`;

      let resolver: any;
      let rejecter: any;
      const promise = new Promise((res, rej) => {
        resolver = res;
        rejecter = rej;
      });

      pendingOAuth = {
        server,
        cancelled: false,
        resolver,
        rejecter
      };

      resolve({
        auth_url: authUrl,
        callback_port: port
      });
    });
  });
}

export async function completeLogin(): Promise<AccountInfo> {
  if (!pendingOAuth) {
    throw new Error("No pending OAuth login");
  }

  const oauthPromise = new Promise<StoredAccount>((resolve, reject) => {
    if (pendingOAuth) {
      const origRes = pendingOAuth.resolver;
      const origRej = pendingOAuth.rejecter;
      pendingOAuth.resolver = (val) => { resolve(val); origRes(val); };
      pendingOAuth.rejecter = (val) => { reject(val); origRej(val); };
    }
  });

  const account = await oauthPromise;
  pendingOAuth = null;

  // Add account to store
  const store = loadAccounts();
  if (store.accounts.some(a => a.name === account.name)) {
    throw new Error(`An account with name '${account.name}' already exists`);
  }

  store.accounts.push(account);
  if (store.accounts.length === 1) {
    store.active_account_id = account.id;
  }

  // Switch to it
  store.active_account_id = account.id;
  account.last_used_at = new Date().toISOString();
  saveAccounts(store);
  syncToAuthJson(account);

  return getAccountInfo(account, store.active_account_id);
}

export async function cancelLogin(): Promise<void> {
  if (pendingOAuth) {
    pendingOAuth.cancelled = true;
    pendingOAuth.server.close();
    pendingOAuth.rejecter(new Error("OAuth login cancelled"));
    pendingOAuth = null;
  }
}

// Switcher commands implementation
export async function listAccounts(): Promise<AccountInfo[]> {
  const store = loadAccounts();
  const activeId = store.active_account_id;
  return store.accounts.map(a => getAccountInfo(a, activeId));
}

export async function getActiveAccountInfo(): Promise<AccountInfo | null> {
  const store = loadAccounts();
  const activeId = store.active_account_id;
  if (!activeId) return null;
  const account = store.accounts.find(a => a.id === activeId);
  return account ? getAccountInfo(account, activeId) : null;
}

export async function addAccountFromFile(pathStr: string, name: string): Promise<AccountInfo> {
  const raw = fs.readFileSync(pathStr, "utf-8");
  const auth: { OPENAI_API_KEY?: string; tokens?: { id_token: string; access_token: string; refresh_token: string; account_id?: string }; last_refresh?: string } = JSON.parse(raw);

  let account: StoredAccount;
  if (auth.OPENAI_API_KEY) {
    account = {
      id: crypto.randomUUID(),
      name,
      email: null,
      plan_type: null,
      subscription_expires_at: null,
      auth_mode: "api_key",
      auth_data: { type: "api_key", key: auth.OPENAI_API_KEY },
      created_at: new Date().toISOString(),
      last_used_at: null
    };
  } else if (auth.tokens) {
    const claims = parseChatGptIdTokenClaims(auth.tokens.id_token);
    account = {
      id: crypto.randomUUID(),
      name,
      email: claims.email,
      plan_type: claims.plan_type,
      subscription_expires_at: claims.subscription_expires_at,
      auth_mode: "chatgpt",
      auth_data: {
        type: "chatgpt",
        id_token: auth.tokens.id_token,
        access_token: auth.tokens.access_token,
        refresh_token: auth.tokens.refresh_token,
        account_id: claims.account_id || auth.tokens.account_id || null
      },
      created_at: new Date().toISOString(),
      last_used_at: null
    };
  } else {
    throw new Error("auth.json contains neither API key nor OAuth tokens");
  }

  const store = loadAccounts();
  if (store.accounts.some(a => a.name === name)) {
    throw new Error(`An account with name '${name}' already exists`);
  }

  store.accounts.push(account);
  if (store.accounts.length === 1) {
    store.active_account_id = account.id;
  }
  saveAccounts(store);

  return getAccountInfo(account, store.active_account_id);
}

export async function addAccountFromAuthJsonText(name: string, contents: string): Promise<AccountInfo> {
  const auth = JSON.parse(contents);

  let account: StoredAccount;
  if (auth.OPENAI_API_KEY) {
    account = {
      id: crypto.randomUUID(),
      name,
      email: null,
      plan_type: null,
      subscription_expires_at: null,
      auth_mode: "api_key",
      auth_data: { type: "api_key", key: auth.OPENAI_API_KEY },
      created_at: new Date().toISOString(),
      last_used_at: null
    };
  } else if (auth.tokens) {
    const claims = parseChatGptIdTokenClaims(auth.tokens.id_token);
    account = {
      id: crypto.randomUUID(),
      name,
      email: claims.email,
      plan_type: claims.plan_type,
      subscription_expires_at: claims.subscription_expires_at,
      auth_mode: "chatgpt",
      auth_data: {
        type: "chatgpt",
        id_token: auth.tokens.id_token,
        access_token: auth.tokens.access_token,
        refresh_token: auth.tokens.refresh_token,
        account_id: claims.account_id || auth.tokens.account_id || null
      },
      created_at: new Date().toISOString(),
      last_used_at: null
    };
  } else {
    throw new Error("auth.json contains neither API key nor OAuth tokens");
  }

  const store = loadAccounts();
  if (store.accounts.some(a => a.name === name)) {
    throw new Error(`An account with name '${name}' already exists`);
  }

  store.accounts.push(account);
  if (store.accounts.length === 1) {
    store.active_account_id = account.id;
  }
  saveAccounts(store);

  return getAccountInfo(account, store.active_account_id);
}

export async function switchAccount(accountId: string): Promise<void> {
  const store = loadAccounts();
  const account = store.accounts.find(a => a.id === accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  // Check if codex is running
  const processInfo = await checkCodexProcesses();
  if (processInfo.count > 0) {
    throw new Error(`${CODEX_RUNNING_SWITCH_BLOCKED_PREFIX}${processInfo.count} Codex process${processInfo.count === 1 ? " is" : "es are"} running`);
  }

  // Sync to auth.json
  syncToAuthJson(account);

  // Update active id
  store.active_account_id = accountId;
  account.last_used_at = new Date().toISOString();
  saveAccounts(store);

  // Kill Antigravity background helper processes if they exist, to force reload
  try {
    const pids = await findAntigravityProcesses();
    for (const pid of pids) {
      try {
        if (process.platform === "win32") {
          exec(`taskkill /F /PID ${pid}`);
        } else {
          exec(`kill -9 ${pid}`);
        }
      } catch (err) {
        // Ignore kill errors
      }
    }
  } catch (err) {
    console.error("Failed to query Antigravity PIDs", err);
  }
}

export async function deleteAccount(accountId: string): Promise<void> {
  const store = loadAccounts();
  const exists = store.accounts.some(a => a.id === accountId);
  if (!exists) {
    throw new Error(`Account not found: ${accountId}`);
  }

  store.accounts = store.accounts.filter(a => a.id !== accountId);
  if (store.active_account_id === accountId) {
    store.active_account_id = store.accounts[0]?.id || null;
  }
  saveAccounts(store);
}

export async function renameAccount(accountId: string, newName: string): Promise<void> {
  const store = loadAccounts();
  if (store.accounts.some(a => a.id !== accountId && a.name === newName)) {
    throw new Error(`An account with name '${newName}' already exists`);
  }

  const account = store.accounts.find(a => a.id === accountId);
  if (!account) {
    throw new Error("Account not found");
  }

  account.name = newName;
  saveAccounts(store);
}

// Usage API Implementation
export async function getUsage(accountId: string): Promise<UsageInfo> {
  const store = loadAccounts();
  const account = store.accounts.find(a => a.id === accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  if (account.auth_mode === "api_key") {
    return {
      account_id: accountId,
      plan_type: "api_key",
      primary_used_percent: null,
      primary_window_minutes: null,
      primary_resets_at: null,
      secondary_used_percent: null,
      secondary_window_minutes: null,
      secondary_resets_at: null,
      has_credits: null,
      unlimited_credits: null,
      credits_balance: null,
      error: "Usage info not available for API key accounts"
    };
  }

  try {
    const freshAccount = await ensureChatGptTokensFresh(account);
    const headers: any = {
      "User-Agent": CODEX_USER_AGENT,
      "Authorization": `Bearer ${freshAccount.auth_data.access_token}`
    };
    if (freshAccount.auth_data.account_id) {
      headers["chatgpt-account-id"] = freshAccount.auth_data.account_id;
    }

    let response = await fetch(`${CHATGPT_BACKEND_API}/wham/usage`, { headers });
    if (response.status === 401) {
      // Retry once after forced refresh
      const refreshed = await refreshChatGptTokens(freshAccount);
      headers["Authorization"] = `Bearer ${refreshed.auth_data.access_token}`;
      if (refreshed.auth_data.account_id) {
        headers["chatgpt-account-id"] = refreshed.auth_data.account_id;
      }
      response = await fetch(`${CHATGPT_BACKEND_API}/wham/usage`, { headers });
    }

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const payload = await response.json() as {
      plan_type: string;
      rate_limit?: {
        primary_window?: { used_percent: number; limit_window_seconds?: number; reset_at?: number };
        secondary_window?: { used_percent: number; limit_window_seconds?: number; reset_at?: number };
      };
      credits?: { has_credits: boolean; unlimited: boolean; balance?: string };
    };

    const primary = payload.rate_limit?.primary_window;
    const secondary = payload.rate_limit?.secondary_window;
    const credits = payload.credits;

    return {
      account_id: accountId,
      plan_type: payload.plan_type,
      primary_used_percent: primary ? primary.used_percent : null,
      primary_window_minutes: primary && primary.limit_window_seconds ? Math.ceil(primary.limit_window_seconds / 60) : null,
      primary_resets_at: primary && primary.reset_at ? primary.reset_at : null,
      secondary_used_percent: secondary ? secondary.used_percent : null,
      secondary_window_minutes: secondary && secondary.limit_window_seconds ? Math.ceil(secondary.limit_window_seconds / 60) : null,
      secondary_resets_at: secondary && secondary.reset_at ? secondary.reset_at : null,
      has_credits: credits ? credits.has_credits : null,
      unlimited_credits: credits ? credits.unlimited : null,
      credits_balance: credits && credits.balance ? credits.balance : null,
      error: null
    };
  } catch (e: any) {
    console.error(`Failed to fetch usage for ${account.name}`, e);
    return {
      account_id: accountId,
      plan_type: null,
      primary_used_percent: null,
      primary_window_minutes: null,
      primary_resets_at: null,
      secondary_used_percent: null,
      secondary_window_minutes: null,
      secondary_resets_at: null,
      has_credits: null,
      unlimited_credits: null,
      credits_balance: null,
      error: e.message || String(e)
    };
  }
}

export async function refreshAccountMetadata(accountId: string): Promise<AccountInfo> {
  const store = loadAccounts();
  const account = store.accounts.find(a => a.id === accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  if (account.auth_mode === "api_key") {
    return getAccountInfo(account, store.active_account_id);
  }

  const refreshed = await refreshChatGptTokens(account);

  // Fetch live metadata
  const headers: any = {
    "User-Agent": CODEX_USER_AGENT,
    "Authorization": `Bearer ${refreshed.auth_data.access_token}`
  };
  const chatgptAccountId = refreshed.auth_data.account_id;
  if (chatgptAccountId) {
    headers["chatgpt-account-id"] = chatgptAccountId;
  }

  const res = await fetch(CHATGPT_ACCOUNTS_CHECK_API, { headers });
  if (!res.ok) {
    throw new Error(`Accounts check API failed: ${res.status}`);
  }

  const payload = await res.json() as {
    accounts: Record<string, {
      account?: { plan_type?: string };
      entitlement?: { expires_at?: string };
    }>;
  };

  const selectedEntry = (chatgptAccountId && payload.accounts[chatgptAccountId]) ||
    payload.accounts["default"] ||
    Object.values(payload.accounts)[0];

  if (!selectedEntry) {
    throw new Error("Accounts check response did not include an entry");
  }

  const livePlanType = selectedEntry.account?.plan_type || null;
  const liveExpiresAt = selectedEntry.entitlement?.expires_at || null;

  // Update store
  const updatedStore = loadAccounts();
  const idx = updatedStore.accounts.findIndex(a => a.id === accountId);
  if (idx !== -1) {
    updatedStore.accounts[idx].plan_type = livePlanType;
    updatedStore.accounts[idx].subscription_expires_at = liveExpiresAt;
    saveAccounts(updatedStore);
  }

  return getAccountInfo(updatedStore.accounts[idx], updatedStore.active_account_id);
}

export async function refreshAllAccountsUsage(): Promise<UsageInfo[]> {
  const store = loadAccounts();
  const list = store.accounts;
  const results: UsageInfo[] = [];

  // Run in concurrency of 10
  const limit = Math.min(10, list.length);
  let index = 0;

  const runQueue = async () => {
    while (index < list.length) {
      const currentIdx = index++;
      const account = list[currentIdx];
      try {
        const usage = await getUsage(account.id);
        results[currentIdx] = usage;
      } catch (err: any) {
        results[currentIdx] = {
          account_id: account.id,
          plan_type: null,
          primary_used_percent: null,
          primary_window_minutes: null,
          primary_resets_at: null,
          secondary_used_percent: null,
          secondary_window_minutes: null,
          secondary_resets_at: null,
          has_credits: null,
          unlimited_credits: null,
          credits_balance: null,
          error: err.message || String(err)
        };
      }
    }
  };

  const runners = Array.from({ length: limit }, () => runQueue());
  await Promise.all(runners);

  return results;
}

// Warm up API call
export async function warmupAccount(accountId: string): Promise<void> {
  const store = loadAccounts();
  const account = store.accounts.find(a => a.id === accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  if (account.auth_mode === "api_key" && account.auth_data.key) {
    const payload = {
      model: "gpt-5.4-mini",
      instructions: "You are Codex.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      store: false,
      stream: false,
      max_output_tokens: 1
    };

    const res = await fetch(`${OPENAI_API}/responses`, {
      method: "POST",
      headers: {
        "User-Agent": CODEX_USER_AGENT,
        "Authorization": `Bearer ${account.auth_data.key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API key warm-up failed with status ${res.status}: ${body}`);
    }
  } else if (account.auth_mode === "chatgpt") {
    const fresh = await ensureChatGptTokensFresh(account);
    const headers: any = {
      "User-Agent": CODEX_USER_AGENT,
      "Authorization": `Bearer ${fresh.auth_data.access_token}`,
      "Content-Type": "application/json"
    };
    if (fresh.auth_data.account_id) {
      headers["chatgpt-account-id"] = fresh.auth_data.account_id;
    }

    const payload = {
      model: "gpt-5.4-mini",
      instructions: "You are Codex.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      store: false,
      stream: true
    };

    let res = await fetch(CHATGPT_CODEX_RESPONSES_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (res.status === 401) {
      const refreshed = await refreshChatGptTokens(fresh);
      headers["Authorization"] = `Bearer ${refreshed.auth_data.access_token}`;
      if (refreshed.auth_data.account_id) {
        headers["chatgpt-account-id"] = refreshed.auth_data.account_id;
      }
      res = await fetch(CHATGPT_CODEX_RESPONSES_API, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ChatGPT warm-up failed with status ${res.status}: ${body}`);
    }
  }
}

export async function warmupAllAccounts(): Promise<WarmupSummary> {
  const store = loadAccounts();
  const list = store.accounts;
  const failed_account_ids: string[] = [];

  const limit = Math.min(10, list.length);
  let index = 0;

  const runQueue = async () => {
    while (index < list.length) {
      const currentIdx = index++;
      const account = list[currentIdx];
      try {
        await warmupAccount(account.id);
      } catch (err) {
        console.error(`Warmup failed for ${account.name}`, err);
        failed_account_ids.push(account.id);
      }
    }
  };

  const runners = Array.from({ length: limit }, () => runQueue());
  await Promise.all(runners);

  return {
    total_accounts: list.length,
    warmed_accounts: list.length - failed_account_ids.length,
    failed_account_ids
  };
}

// Slim encoding / decoding
export async function exportAccountsSlimText(): Promise<String> {
  const store = loadAccounts();
  const activeName = store.active_account_id ? (store.accounts.find(a => a.id === store.active_account_id)?.name || null) : null;
  const accountsPayload = store.accounts.map(a => {
    if (a.auth_mode === "api_key") {
      return {
        n: a.name,
        t: SLIM_AUTH_API_KEY,
        k: a.auth_data.key
      };
    } else {
      return {
        n: a.name,
        t: SLIM_AUTH_CHATGPT,
        r: a.auth_data.refresh_token
      };
    }
  });

  const payload = {
    v: SLIM_FORMAT_VERSION,
    a: activeName,
    c: accountsPayload
  };

  const compressed = zlib.deflateSync(JSON.stringify(payload));
  const base64Url = compressed.toString("base64url");
  return `${SLIM_EXPORT_PREFIX}${base64Url}`;
}

export async function importAccountsSlimText(payloadStr: string): Promise<ImportAccountsSummary> {
  const normalized = payloadStr.replace(/\s/g, "");
  if (!normalized) throw new Error("Import string is empty");

  const base64Url = normalized.startsWith(SLIM_EXPORT_PREFIX) ? normalized.slice(SLIM_EXPORT_PREFIX.length) : normalized;
  const compressed = Buffer.from(base64Url, "base64url");
  const decompressed = zlib.inflateSync(compressed);
  if (decompressed.length > MAX_IMPORT_JSON_BYTES) {
    throw new Error("Decompressed payload too large");
  }

  const parsed = JSON.parse(decompressed.toString("utf-8"));
  if (parsed.v !== SLIM_FORMAT_VERSION) {
    throw new Error(`Unsupported slim payload version: ${parsed.v}`);
  }

  const current = loadAccounts();
  const existingNames = new Set(current.accounts.map(a => a.name));
  const importedAccounts: StoredAccount[] = [];

  // Restore accounts concurrently
  const list = parsed.c || [];
  const limit = Math.min(SLIM_IMPORT_CONCURRENCY, list.length);
  let index = 0;

  const runQueue = async () => {
    while (index < list.length) {
      const entry = list[index++];
      if (existingNames.has(entry.n)) continue;

      if (entry.t === SLIM_AUTH_API_KEY) {
        importedAccounts.push({
          id: crypto.randomUUID(),
          name: entry.n,
          email: null,
          plan_type: null,
          subscription_expires_at: null,
          auth_mode: "api_key",
          auth_data: { type: "api_key", key: entry.k },
          created_at: new Date().toISOString(),
          last_used_at: null
        });
      } else if (entry.t === SLIM_AUTH_CHATGPT) {
        try {
          const account = await createChatGptAccountFromRefreshToken(entry.n, entry.r);
          importedAccounts.push(account);
        } catch (err) {
          console.error(`Failed to restore slim account ${entry.n}`, err);
          throw new Error(`Failed to restore ChatGPT account '${entry.n}' from refresh token`);
        }
      }
    }
  };

  const runners = Array.from({ length: limit }, () => runQueue());
  await Promise.all(runners);

  let importedCount = 0;
  for (const account of importedAccounts) {
    current.accounts.push(account);
    importedCount++;
  }

  // Handle active account restore
  if (parsed.a) {
    const matched = current.accounts.find(a => a.name === parsed.a);
    if (matched) {
      current.active_account_id = matched.id;
    }
  }

  if (!current.active_account_id && current.accounts.length > 0) {
    current.active_account_id = current.accounts[0].id;
  }

  saveAccounts(current);

  return {
    total_in_payload: list.length,
    imported_count: importedCount,
    skipped_count: list.length - importedCount
  };
}

// Full backup operations (Encrypted bytes/files)
export function encodeFullEncryptedStore(store: AccountsStore, passphrase = FULL_PRESET_PASSPHRASE): Buffer {
  const rawBytes = Buffer.from(JSON.stringify(store), "utf-8");
  const compressed = zlib.deflateSync(rawBytes);

  const salt = crypto.randomBytes(FULL_SALT_LEN);
  const nonce = crypto.randomBytes(FULL_NONCE_LEN);

  const key = crypto.pbkdf2Sync(passphrase, salt, FULL_KDF_ITERATIONS, 32, "sha256");

  const xc = xchacha20poly1305(key, nonce);
  const ciphertext = xc.encrypt(compressed);

  const out = Buffer.alloc(4 + 1 + FULL_SALT_LEN + FULL_NONCE_LEN + ciphertext.length);
  out.write(FULL_FILE_MAGIC, 0, 4, "utf-8");
  out.writeUInt8(FULL_FILE_VERSION, 4);
  salt.copy(out, 5);
  nonce.copy(out, 5 + FULL_SALT_LEN);
  Buffer.from(ciphertext).copy(out, 5 + FULL_SALT_LEN + FULL_NONCE_LEN);

  return out;
}

export function decodeFullEncryptedStore(fileBytes: Buffer, passphrase = FULL_PRESET_PASSPHRASE): AccountsStore {
  if (fileBytes.length > MAX_IMPORT_FILE_BYTES) {
    throw new Error("Encrypted file is too large");
  }

  const headerLen = 4 + 1 + FULL_SALT_LEN + FULL_NONCE_LEN;
  if (fileBytes.length <= headerLen) {
    throw new Error("Encrypted file is invalid or truncated");
  }

  if (fileBytes.toString("utf-8", 0, 4) !== FULL_FILE_MAGIC) {
    throw new Error("Encrypted file header is invalid");
  }

  const version = fileBytes.readUInt8(4);
  if (version !== FULL_FILE_VERSION) {
    throw new Error(`Unsupported encrypted file version: ${version}`);
  }

  const salt = fileBytes.subarray(5, 5 + FULL_SALT_LEN);
  const nonce = fileBytes.subarray(5 + FULL_SALT_LEN, 5 + FULL_SALT_LEN + FULL_NONCE_LEN);
  const ciphertext = fileBytes.subarray(5 + FULL_SALT_LEN + FULL_NONCE_LEN);

  const key = crypto.pbkdf2Sync(passphrase, salt, FULL_KDF_ITERATIONS, 32, "sha256");

  const xc = xchacha20poly1305(key, nonce);
  const compressed = xc.decrypt(ciphertext);

  const jsonBytes = zlib.inflateSync(compressed);
  if (jsonBytes.length > MAX_IMPORT_JSON_BYTES) {
    throw new Error("Decompressed payload is too large");
  }

  return JSON.parse(jsonBytes.toString("utf-8"));
}

export async function exportAccountsFullEncryptedFile(filePath: string): Promise<void> {
  const store = loadAccounts();
  const buffer = encodeFullEncryptedStore(store);
  fs.writeFileSync(filePath, buffer);
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o600);
  }
}

export async function exportAccountsFullEncryptedBytes(): Promise<string> {
  const store = loadAccounts();
  const buffer = encodeFullEncryptedStore(store);
  return buffer.toString("base64");
}

export async function importAccountsFullEncryptedFile(filePath: string): Promise<ImportAccountsSummary> {
  const bytes = fs.readFileSync(filePath);
  const store = decodeFullEncryptedStore(bytes);
  return mergeAccountsStore(store);
}

export async function importAccountsFullEncryptedBytes(base64Str: string): Promise<ImportAccountsSummary> {
  const bytes = Buffer.from(base64Str, "base64");
  const store = decodeFullEncryptedStore(bytes);
  return mergeAccountsStore(store);
}

function mergeAccountsStore(imported: AccountsStore): ImportAccountsSummary {
  const current = loadAccounts();
  const existingIds = new Set(current.accounts.map(a => a.id));
  const existingNames = new Set(current.accounts.map(a => a.name));
  const total = imported.accounts.length;
  let importedCount = 0;

  for (const account of imported.accounts) {
    if (existingIds.has(account.id) || existingNames.has(account.name)) {
      continue;
    }
    current.accounts.push(account);
    importedCount++;
  }

  current.version = Math.max(current.version, imported.version || 1);

  const currentActiveValid = current.active_account_id && current.accounts.some(a => a.id === current.active_account_id);
  if (!currentActiveValid) {
    if (imported.active_account_id && current.accounts.some(a => a.id === imported.active_account_id)) {
      current.active_account_id = imported.active_account_id;
    } else {
      current.active_account_id = current.accounts[0]?.id || null;
    }
  }

  saveAccounts(current);

  return {
    total_in_payload: total,
    imported_count: importedCount,
    skipped_count: total - importedCount
  };
}

// Masked accounts
export async function getMaskedAccountIds(): Promise<string[]> {
  const store = loadAccounts();
  return store.masked_account_ids || [];
}

export async function setMaskedAccountIds(ids: string[]): Promise<void> {
  const store = loadAccounts();
  store.masked_account_ids = ids;
  saveAccounts(store);
}

// Process Management Implementation
export async function checkCodexProcesses(): Promise<CodexProcessInfo> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const psScript = `
$windowTitles = @{};
Get-Process -Name Codex -ErrorAction SilentlyContinue | ForEach-Object {
  $windowTitles[[uint32]$_.Id] = [string]$_.MainWindowTitle
};
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq 'Codex.exe' -or $_.Name -ieq 'codex.exe' } |
  ForEach-Object {
    [PSCustomObject]@{
      Name = [string]$_.Name;
      ProcessId = [uint32]$_.ProcessId;
      ParentProcessId = [uint32]$_.ParentProcessId;
      CommandLine = [string]$_.CommandLine;
      MainWindowTitle = [string]$windowTitles[[uint32]$_.ProcessId];
    }
  } | ConvertTo-Json -Compress;
      `;

      exec(`powershell.exe -NoProfile -NonInteractive -Command "${psScript.trim().replace(/\n/g, " ")}"`, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve({ count: 0, background_count: 0, can_switch: true, pids: [] });
          return;
        }

        try {
          const rawProcs = stdout.trim();
          let processes: any[] = [];
          if (rawProcs.startsWith("[")) {
            processes = JSON.parse(rawProcs);
          } else if (rawProcs.startsWith("{")) {
            processes = [JSON.parse(rawProcs)];
          }

          const activePids: number[] = [];
          let ignoredCount = 0;

          // Helper to check if a process is a root process
          const isRootProcess = (proc: any) => {
            const name = proc.Name.toLowerCase();
            const cmd = proc.CommandLine.toLowerCase();
            return name === "codex.exe" && !cmd.includes("codex-switcher") && !cmd.includes("--type=") && !cmd.includes("resources\\codex.exe");
          };

          const hasDescendantMatching = (rootPid: number, predicate: (p: any) => boolean): boolean => {
            const queue = [rootPid];
            const visited = new Set<number>();
            while (queue.length > 0) {
              const parent = queue.pop()!;
              const children = processes.filter(p => p.ParentProcessId === parent);
              for (const child of children) {
                if (!visited.has(child.ProcessId)) {
                  visited.add(child.ProcessId);
                  if (predicate(child)) return true;
                  queue.push(child.ProcessId);
                }
              }
            }
            return false;
          };

          for (const proc of processes.filter(isRootProcess)) {
            const cmd = proc.CommandLine.toLowerCase();
            if (cmd.includes(".antigravity") || cmd.includes("openai.chatgpt") || cmd.includes(".vscode")) {
              ignoredCount++;
              continue;
            }

            const hasWindow = proc.MainWindowTitle.trim().length > 0;
            const hasRenderer = hasDescendantMatching(proc.ProcessId, (c) => c.CommandLine.toLowerCase().includes("--type=renderer"));
            const hasAppServer = hasDescendantMatching(proc.ProcessId, (c) => {
              const childCmd = c.CommandLine.toLowerCase();
              return childCmd.includes("resources\\codex.exe") && childCmd.includes("app-server");
            });

            if (hasWindow || hasRenderer || hasAppServer) {
              activePids.push(proc.ProcessId);
            } else {
              ignoredCount++;
            }
          }

          resolve({
            count: activePids.length,
            background_count: ignoredCount,
            can_switch: activePids.length === 0,
            pids: activePids
          });
        } catch (e) {
          console.error("Failed to parse powershell JSON", e);
          resolve({ count: 0, background_count: 0, can_switch: true, pids: [] });
        }
      });
    } else {
      // Unix / macOS
      exec("ps -axo pid=,tty=,command=", (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve({ count: 0, background_count: 0, can_switch: true, pids: [] });
          return;
        }

        const lines = stdout.split("\n");
        const activePids: number[] = [];
        let ignoredCount = 0;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.+)$/);
          if (!match) continue;

          const pid = parseInt(match[1]);
          const tty = match[2];
          const command = match[3];

          if (command.toLowerCase().includes("codex-switcher")) continue;

          // Check if codex
          const firstToken = command.split(/\s+/)[0];
          const isCodexCli = firstToken === "codex" || firstToken.endsWith("/codex");
          const isCodexDesktop = command.includes("/Codex.app/Contents/MacOS/Codex");

          if (!isCodexCli && !isCodexDesktop) continue;
          if (pid === process.pid) continue;

          const cmdLower = command.toLowerCase();
          const isIdePlugin = cmdLower.includes(".antigravity") || cmdLower.includes("openai.chatgpt") || cmdLower.includes(".vscode");
          const isAppServer = cmdLower.includes("codex app-server");
          const hasTty = tty !== "??" && tty !== "?";

          if (isIdePlugin || isAppServer) {
            ignoredCount++;
            continue;
          }

          if (isCodexDesktop || hasTty) {
            activePids.push(pid);
          } else {
            ignoredCount++;
          }
        }

        resolve({
          count: activePids.length,
          background_count: ignoredCount,
          can_switch: activePids.length === 0,
          pids: activePids
        });
      });
    }
  });
}

export async function killCodexProcesses(): Promise<KillCodexProcessesResult> {
  const info = await checkCodexProcesses();
  const killed_pids: number[] = [];
  const failed_pids: number[] = [];

  if (info.pids.length === 0) {
    return { targeted_count: 0, killed_pids: [], failed_pids: [] };
  }

  // Expand targets (just target pids on Windows, or get child tree on unix)
  let targets = [...info.pids];

  if (process.platform !== "win32") {
    // Unix child processes tree resolution
    try {
      const snapshotStdout = execSync("ps -axo pid=,ppid=,uid=").toString();
      const childrenByParent = new Map<number, number[]>();
      const lines = snapshotStdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        const pid = parseInt(parts[0]);
        const ppid = parseInt(parts[1]);
        if (!isNaN(pid) && !isNaN(ppid)) {
          if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
          childrenByParent.get(ppid)!.push(pid);
        }
      }

      const expanded: number[] = [];
      const visited = new Set<number>();
      for (const rootPid of info.pids) {
        const stack = [...(childrenByParent.get(rootPid) || [])];
        while (stack.length > 0) {
          const p = stack.pop()!;
          if (!visited.has(p)) {
            visited.add(p);
            expanded.push(p);
            stack.push(...(childrenByParent.get(p) || []));
          }
        }
      }

      for (const rootPid of info.pids) {
        if (!visited.has(rootPid)) {
          expanded.push(rootPid);
        }
      }
      targets = expanded;
    } catch (err) {
      console.error("Failed to expand unix process tree", err);
    }
  }

  // Kill processes
  for (const pid of targets) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /T /PID ${pid}`);
      } else {
        execSync(`kill -9 ${pid}`);
      }
      killed_pids.push(pid);
    } catch (err) {
      // Check if it still exists
      if (processExists(pid)) {
        failed_pids.push(pid);
      } else {
        killed_pids.push(pid);
      }
    }
  }

  // Handle Mac admin privilege escalation if some failed
  if (process.platform === "darwin" && failed_pids.length > 0) {
    try {
      const pidStr = failed_pids.join(" ");
      const script = `do shell script "for pid in ${pidStr}; do /bin/kill -9 \\"$pid\\" 2>/dev/null || true; done" with administrator privileges with prompt "Codex Switcher needs permission to force close sudo/root Codex processes."`;
      execSync(`/usr/bin/osascript -e '${script}'`);

      const stillFailed: number[] = [];
      for (const pid of failed_pids) {
        if (processExists(pid)) {
          stillFailed.push(pid);
        } else {
          killed_pids.push(pid);
        }
      }
      return {
        targeted_count: info.pids.length,
        killed_pids,
        failed_pids: stillFailed
      };
    } catch (e) {
      console.error("Mac administrator privileges check failed", e);
    }
  }

  return {
    targeted_count: info.pids.length,
    killed_pids,
    failed_pids
  };
}

function processExists(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).toString();
      return out.includes(pid.toString());
    } else {
      const out = execSync(`ps -p ${pid} -o pid=`).toString();
      return out.trim() === pid.toString();
    }
  } catch {
    return false;
  }
}

async function findAntigravityProcesses(): Promise<number[]> {
  const pids: number[] = [];
  try {
    if (process.platform === "win32") {
      const out = execSync("tasklist /FI \"IMAGENAME eq codex.exe\" /FO CSV /NH").toString();
      const lines = out.split("\n");
      for (const line of lines) {
        const parts = line.split(",");
        if (parts.length > 1) {
          const name = parts[0].replace(/"/g, "").trim().toLowerCase();
          if (name === "codex.exe") {
            const pid = parseInt(parts[1].replace(/"/g, "").trim());
            if (!isNaN(pid)) pids.push(pid);
          }
        }
      }
    } else {
      const out = execSync("ps -eo pid,command").toString();
      const lines = out.split("\n").slice(1);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const spaceIdx = trimmed.indexOf(" ");
        if (spaceIdx === -1) continue;
        const pidStr = trimmed.substring(0, spaceIdx).trim();
        const command = trimmed.substring(spaceIdx).trim();

        const isAntigravity = (command.includes(".antigravity/extensions/openai.chatgpt") || command.includes(".vscode/extensions/openai.chatgpt")) &&
          (command.endsWith("codex app-server --analytics-default-enabled") || command.includes("/codex app-server"));

        if (isAntigravity) {
          const pid = parseInt(pidStr);
          if (!isNaN(pid)) pids.push(pid);
        }
      }
    }
  } catch (err) {
    console.error("Failed to query Antigravity processes", err);
  }
  return pids;
}

export async function openCodexApp(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === "darwin") {
      exec("open -b com.openai.codex", (err) => {
        if (!err) { resolve(); return; }
        exec("open -a Codex", (err2) => {
          if (!err2) { resolve(); return; }
          reject(new Error("Codex app is not installed or could not be opened"));
        });
      });
    } else if (process.platform === "win32") {
      // Check registered App first via PowerShell
      const startScript = `
$app = Get-StartApps | Where-Object { $_.Name -like '*Codex*' -or $_.AppID -like '*Codex*' } | Select-Object -First 1
if ($null -eq $app) { exit 1 }
Start-Process ("shell:AppsFolder\\" + $app.AppID)
      `;
      exec(`powershell.exe -NoProfile -NonInteractive -Command "${startScript.trim().replace(/\n/g, " ")}"`, (err) => {
        if (!err) { resolve(); return; }

        // Find standard paths
        const paths = [
          path.join(process.env.LOCALAPPDATA || "", "Programs", "Codex", "Codex.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Programs", "codex", "Codex.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Codex", "Codex.exe"),
          path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "Codex.exe"),
          path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin", "codex.exe"),
          path.join(process.env.LOCALAPPDATA || "", "OpenAI Codex", "Codex.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Codex Desktop", "Codex.exe"),
          path.join(process.env.ProgramFiles || "", "Codex", "Codex.exe"),
          path.join(process.env.ProgramFiles || "", "OpenAI", "Codex", "Codex.exe"),
          path.join(process.env.ProgramFiles || "", "OpenAI Codex", "Codex.exe"),
          path.join(process.env["ProgramFiles(x86)"] || "", "Codex", "Codex.exe")
        ];

        // Search in local packages cache
        const packagesDir = path.join(process.env.LOCALAPPDATA || "", "Packages");
        if (fs.existsSync(packagesDir)) {
          try {
            const dirs = fs.readdirSync(packagesDir);
            for (const d of dirs) {
              if (d.toLowerCase().startsWith("openai.codex_")) {
                paths.push(path.join(packagesDir, d, "LocalCache", "Local", "OpenAI", "Codex", "bin", "codex.exe"));
              }
            }
          } catch (e) {
            // Ignore readdir errors
          }
        }

        const validPath = paths.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
        if (validPath) {
          const dir = path.dirname(validPath);
          const cp = spawn(validPath, [], { detached: true, stdio: "ignore", cwd: dir });
          cp.unref();
          resolve();
          return;
        }

        // Try shortcuts
        const lnkPaths: string[] = [];
        const shortcutDirs = [
          path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
          path.join(process.env.ProgramData || "", "Microsoft", "Windows", "Start Menu", "Programs")
        ];

        const collectShortcuts = (dir: string, depth = 0) => {
          if (depth > 2 || !fs.existsSync(dir)) return;
          try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
              const full = path.join(dir, file);
              if (fs.statSync(full).isDirectory()) {
                collectShortcuts(full, depth + 1);
              } else if (file.toLowerCase().includes("codex") && file.endsWith(".lnk")) {
                lnkPaths.push(full);
              }
            }
          } catch (e) {}
        };

        for (const dir of shortcutDirs) {
          collectShortcuts(dir);
        }

        if (lnkPaths.length > 0) {
          exec(`cmd.exe /C start "" "${lnkPaths[0]}"`, (err3) => {
            if (!err3) { resolve(); return; }
            reject(new Error("Codex app is not installed or could not be opened"));
          });
        } else {
          reject(new Error("Codex app is not installed or could not be opened"));
        }
      });
    } else {
      reject(new Error("Opening Codex app is only supported on macOS and Windows"));
    }
  });
}
