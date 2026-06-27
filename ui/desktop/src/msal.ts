// Microsoft Entra (MSAL) sign-in for the Caros provider, in the Electron main process.
//
// The app registration exposes only a "Mobile and desktop applications" platform
// (redirect http://localhost, public-client flows) — there is no SPA platform — so
// auth must run here with msal-node using the loopback auth-code + PKCE flow, not in
// the renderer with msal-browser. The renderer triggers sign-in over IPC and pushes
// the resulting bearer to goosed (CAROS_TOKEN). MSAL owns refresh: a periodic silent
// acquisition keeps goosed's token fresh, so we deliberately do NOT hand goosed a
// refresh token (its own CLI refresh path stays dormant — see crates/goose caros.rs).

import {
  CryptoProvider,
  LogLevel,
  PublicClientApplication,
  type AuthenticationResult,
  type Configuration,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node';
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const TENANT = '16ed5ab4-2b59-4e40-806d-8a30bdc9cf26';
const CLIENT_ID = '5284f3e5-40c4-43e3-92b2-512af17f64cc';
// Delegated scope on contralib-api; yields a token with aud=api://ea4c58eb-… for APIM.
const SCOPES = ['api://ea4c58eb-9223-46bd-89cc-06bf4652f43c/access_as_user'];
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
// Re-acquire well inside the ~1h access-token TTL; acquireTokenSilent refreshes as needed.
const RENEWAL_INTERVAL_MS = 30 * 60 * 1000;

export interface CarosToken {
  accessToken: string;
  /** Absolute expiry, unix seconds (matches CAROS_TOKEN_EXPIRY the provider reads). */
  expiresAt: number;
  username: string;
  name: string;
}

export interface CarosAuthStatus {
  signedIn: boolean;
  /** Display name from the id token. */
  name?: string;
  /** UPN / email from the id token. */
  email?: string;
  /** Microsoft Graph profile photo as a data URL, when available. */
  avatarDataUrl?: string;
  expiresAt?: number;
}

function cacheFilePath(): string {
  return path.join(app.getPath('userData'), 'caros-msal-cache.bin');
}

function readCache(): string {
  const file = cacheFilePath();
  if (!fs.existsSync(file)) return '';
  const buf = fs.readFileSync(file);
  if (buf.length === 0) return '';
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch (e) {
    console.warn('[caros-auth] failed to read token cache, ignoring:', e);
    return '';
  }
}

function writeCache(data: string): void {
  try {
    const buf = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(data)
      : Buffer.from(data, 'utf8');
    fs.writeFileSync(cacheFilePath(), buf, { mode: 0o600 });
  } catch (e) {
    console.warn('[caros-auth] failed to persist token cache:', e);
  }
}

const cachePlugin: ICachePlugin = {
  beforeCacheAccess: async (ctx: TokenCacheContext) => {
    const data = readCache();
    if (data) ctx.tokenCache.deserialize(data);
  },
  afterCacheAccess: async (ctx: TokenCacheContext) => {
    if (ctx.cacheHasChanged) writeCache(ctx.tokenCache.serialize());
  },
};

let pca: PublicClientApplication | undefined;
function getApp(): PublicClientApplication {
  if (!pca) {
    const config: Configuration = {
      auth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${TENANT}`,
      },
      cache: { cachePlugin },
      system: {
        loggerOptions: {
          loggerCallback: () => {},
          piiLoggingEnabled: false,
          logLevel: LogLevel.Error,
        },
      },
    };
    pca = new PublicClientApplication(config);
  }
  return pca;
}

function toToken(result: AuthenticationResult): CarosToken {
  return {
    accessToken: result.accessToken,
    expiresAt: result.expiresOn ? Math.floor(result.expiresOn.getTime() / 1000) : 0,
    username: result.account?.username ?? '',
    name: result.account?.name ?? '',
  };
}

// Cached Graph profile photo: undefined = not yet fetched, null = none/unavailable.
let cachedAvatar: string | null | undefined;

/**
 * Fetch the signed-in user's Microsoft Graph profile photo as a data URL.
 * Uses a separate Graph (User.Read) token; returns null if Graph consent or a
 * photo isn't available (callers fall back to initials).
 */
async function getAvatarDataUrl(): Promise<string | null> {
  if (cachedAvatar !== undefined) return cachedAvatar;
  cachedAvatar = null;
  try {
    const client = getApp();
    const accounts = await client.getTokenCache().getAllAccounts();
    if (accounts.length === 0) return null;
    const result = await client.acquireTokenSilent({ account: accounts[0]!, scopes: ['User.Read'] });
    const resp = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
      headers: { Authorization: `Bearer ${result.accessToken}` },
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
    const base64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
    cachedAvatar = `data:${contentType};base64,${base64}`;
  } catch (e) {
    console.warn('[caros-auth] could not fetch Graph avatar:', e);
    cachedAvatar = null;
  }
  return cachedAvatar;
}

function resultPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Caros</title></head>
<body style="font-family:system-ui;display:flex;height:100vh;align-items:center;justify-content:center;margin:0">
<p style="font-size:1.1rem">${message}</p></body></html>`;
}

/** Interactive sign-in via the loopback auth-code + PKCE flow. */
export async function signIn(): Promise<CarosToken> {
  const client = getApp();
  const crypto = new CryptoProvider();
  const { verifier, challenge } = await crypto.generatePkceCodes();
  // CSRF/replay guard for the loopback redirect: only accept a callback that echoes
  // this exact state, so a co-resident process can't inject its own auth code.
  const state = randomBytes(32).toString('hex');

  return await new Promise<CarosToken>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      server.close();
      clearTimeout(timer);
      fn();
    };

    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://localhost');
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      if (!code && !error) {
        res.statusCode = 204; // favicon / stray requests — keep waiting
        res.end();
        return;
      }
      if (error) {
        const desc = reqUrl.searchParams.get('error_description') ?? error;
        res.end(resultPage('Sign-in failed. You can close this window.'));
        finish(() => reject(new Error(desc)));
        return;
      }
      if (reqUrl.searchParams.get('state') !== state) {
        res.end(resultPage('Sign-in failed. You can close this window.'));
        finish(() => reject(new Error('Caros sign-in failed: OAuth state mismatch')));
        return;
      }
      try {
        const redirectUri = `http://localhost:${(server.address() as AddressInfo).port}`;
        const result = await client.acquireTokenByCode({
          code: code!,
          scopes: SCOPES,
          redirectUri,
          codeVerifier: verifier,
        });
        res.end(resultPage('Signed in to Caros. You can close this window and return to the app.'));
        finish(() => resolve(toToken(result)));
      } catch (e) {
        res.end(resultPage('Sign-in failed. You can close this window.'));
        finish(() => reject(e as Error));
      }
    });

    const timer = setTimeout(
      () => finish(() => reject(new Error('Caros sign-in timed out'))),
      SIGN_IN_TIMEOUT_MS
    );

    server.on('error', (e) => finish(() => reject(e)));
    server.listen(0, '127.0.0.1', async () => {
      try {
        const redirectUri = `http://localhost:${(server.address() as AddressInfo).port}`;
        const authUrl = await client.getAuthCodeUrl({
          scopes: SCOPES,
          redirectUri,
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          state,
        });
        await shell.openExternal(authUrl);
      } catch (e) {
        finish(() => reject(e as Error));
      }
    });
  });
}

/** Silent (cached/refreshed) acquisition; null if not signed in or refresh failed. */
export async function signInSilent(): Promise<CarosToken | null> {
  const client = getApp();
  const accounts = await client.getTokenCache().getAllAccounts();
  if (accounts.length === 0) return null;
  try {
    const result = await client.acquireTokenSilent({ account: accounts[0]!, scopes: SCOPES });
    return toToken(result);
  } catch (e) {
    console.warn('[caros-auth] silent token acquisition failed:', e);
    return null;
  }
}

export async function signOut(): Promise<void> {
  const cache = getApp().getTokenCache();
  for (const account of await cache.getAllAccounts()) {
    await cache.removeAccount(account);
  }
  cachedAvatar = undefined;
  try {
    fs.rmSync(cacheFilePath(), { force: true });
  } catch {
    // best effort
  }
}

export async function getStatus(): Promise<CarosAuthStatus> {
  const token = await signInSilent();
  if (!token) return { signedIn: false };
  const avatarDataUrl = await getAvatarDataUrl();
  return {
    signedIn: true,
    name: token.name,
    email: token.username,
    expiresAt: token.expiresAt,
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
  };
}

let renewalTimer: ReturnType<typeof setInterval> | undefined;

/** Register IPC handlers and start the background renewal broadcaster (idempotent). */
export function registerCarosAuthIpc(): void {
  ipcMain.handle('caros:sign-in', () => signIn());
  ipcMain.handle('caros:sign-out', () => signOut());
  ipcMain.handle('caros:status', () => getStatus());

  if (!renewalTimer) {
    renewalTimer = setInterval(async () => {
      const token = await signInSilent();
      if (!token) return;
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('caros:token-renewed', token);
      }
    }, RENEWAL_INTERVAL_MS);
    renewalTimer.unref?.();
  }
}
