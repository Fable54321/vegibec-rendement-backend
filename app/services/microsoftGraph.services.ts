import crypto from "crypto";
import { pool } from "../db";

const graphBaseUrl = "https://graph.microsoft.com/v1.0";
const microsoftLoginBaseUrl = "https://login.microsoftonline.com";
const scopes = ["openid", "profile", "offline_access", "User.Read", "Mail.ReadBasic"];

type MicrosoftConnectionRow = {
  user_id: number;
  microsoft_user_id: string;
  email: string;
  display_name: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  expires_at: Date | string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

export type OutlookMessage = {
  id: string;
  subject: string;
  receivedDateTime: string;
  webLink: string;
  from?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
};

const requireMicrosoftConfig = () => {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  const tenantId = process.env.MICROSOFT_TENANT_ID?.trim() || "organizations";
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI?.trim();
  const encryptionSecret = process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY?.trim();

  if (!clientId || !clientSecret || !redirectUri || !encryptionSecret) {
    throw new Error("Microsoft Graph integration is not configured");
  }
  if (encryptionSecret.length < 32) {
    throw new Error("MICROSOFT_TOKEN_ENCRYPTION_KEY must contain at least 32 characters");
  }

  return { clientId, clientSecret, tenantId, redirectUri, encryptionSecret };
};

const encryptionKey = () =>
  crypto.createHash("sha256").update(requireMicrosoftConfig().encryptionSecret).digest();

const encryptToken = (value: string) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
};

const decryptToken = (value: string) => {
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !encrypted) throw new Error("Invalid encrypted Microsoft token");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
};

const tokenEndpoint = () => {
  const { tenantId } = requireMicrosoftConfig();
  return `${microsoftLoginBaseUrl}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
};

const requestTokens = async (parameters: Record<string, string>) => {
  const response = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
  });
  const body = await response.json() as TokenResponse & { error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || "Microsoft token request failed");
  }
  return body;
};

export const getMicrosoftAuthorizationUrl = (state: string) => {
  const { clientId, tenantId, redirectUri } = requireMicrosoftConfig();
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: scopes.join(" "),
    state,
    prompt: "select_account",
  });
  return `${microsoftLoginBaseUrl}/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize?${query}`;
};

const graphRequest = async <T>(accessToken: string, path: string) => {
  const response = await fetch(`${graphBaseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'IdType="ImmutableId"',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Microsoft Graph request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
};

export const exchangeMicrosoftCode = async (code: string) => {
  const { clientId, clientSecret, redirectUri } = requireMicrosoftConfig();
  const tokens = await requestTokens({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
  });
  if (!tokens.refresh_token) throw new Error("Microsoft did not return a refresh token");

  const profile = await graphRequest<{
    id: string;
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
  }>(tokens.access_token, "/me?$select=id,displayName,mail,userPrincipalName");

  return { tokens, profile };
};

export const saveMicrosoftConnection = async (
  userId: number,
  data: Awaited<ReturnType<typeof exchangeMicrosoftCode>>,
) => {
  await pool.query(
    `INSERT INTO sales.microsoft_connections
      (user_id, microsoft_user_id, email, display_name, access_token_encrypted,
       refresh_token_encrypted, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 * INTERVAL '1 second'), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       microsoft_user_id = EXCLUDED.microsoft_user_id,
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [
      userId,
      data.profile.id,
      data.profile.mail || data.profile.userPrincipalName || "",
      data.profile.displayName || "",
      encryptToken(data.tokens.access_token),
      encryptToken(data.tokens.refresh_token!),
      data.tokens.expires_in,
    ],
  );
};

const getConnection = async (userId: number) => {
  const result = await pool.query<MicrosoftConnectionRow>(
    "SELECT * FROM sales.microsoft_connections WHERE user_id = $1",
    [userId],
  );
  return result.rows[0];
};

export const getMicrosoftConnectionStatus = async (userId: number) => {
  const connection = await getConnection(userId);
  return connection
    ? { connected: true, email: connection.email, displayName: connection.display_name }
    : { connected: false };
};

export const disconnectMicrosoftAccount = async (userId: number) => {
  await pool.query("DELETE FROM sales.microsoft_connections WHERE user_id = $1", [userId]);
};

const refreshMicrosoftToken = async (connection: MicrosoftConnectionRow) => {
  const { clientId, clientSecret } = requireMicrosoftConfig();
  const tokens = await requestTokens({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: decryptToken(connection.refresh_token_encrypted),
    scope: scopes.join(" "),
  });
  const refreshToken = tokens.refresh_token || decryptToken(connection.refresh_token_encrypted);
  await pool.query(
    `UPDATE sales.microsoft_connections
     SET access_token_encrypted = $1, refresh_token_encrypted = $2,
         expires_at = NOW() + ($3 * INTERVAL '1 second'), updated_at = NOW()
     WHERE user_id = $4`,
    [encryptToken(tokens.access_token), encryptToken(refreshToken), tokens.expires_in, connection.user_id],
  );
  return tokens.access_token;
};

const getAccessToken = async (userId: number) => {
  const connection = await getConnection(userId);
  if (!connection) {
    const error = new Error("Microsoft account is not connected");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }
  const expiresAt = new Date(connection.expires_at).getTime();
  if (expiresAt > Date.now() + 60_000) return decryptToken(connection.access_token_encrypted);
  return refreshMicrosoftToken(connection);
};

export const listOutlookMessages = async (userId: number, search: string) => {
  const accessToken = await getAccessToken(userId);
  const query = new URLSearchParams({
    $select: "id,subject,from,receivedDateTime,webLink",
    $top: "25",
  });
  if (search.trim()) query.set("$search", `"${search.trim().replace(/"/g, "")}"`);
  else query.set("$orderby", "receivedDateTime desc");
  const result = await graphRequest<{ value: OutlookMessage[] }>(
    accessToken,
    `/me/messages?${query.toString()}`,
  );
  return result.value;
};

export const getOutlookMessage = async (userId: number, messageId: string) => {
  const accessToken = await getAccessToken(userId);
  return graphRequest<OutlookMessage>(
    accessToken,
    `/me/messages/${encodeURIComponent(messageId)}?$select=id,subject,from,receivedDateTime,webLink`,
  );
};
