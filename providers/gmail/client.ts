/**
 * providers/gmail/client.ts — Gmail REST API v1 helpers (M2)
 *
 * Thin fetch wrappers around the Gmail API. Each function takes a plaintext
 * accessToken (decrypted in-memory by the caller via getValidAccessToken).
 *
 * Security:
 * - Never log the accessToken (§7.2)
 * - Never log full email body (may contain PII)
 * - All calls wrapped in try/catch; throw non-sensitive errors to caller
 *
 * These cover exactly the operations email triage needs (§7.5 — minimum):
 *   - list unread message IDs
 *   - fetch a single message with decoded body
 *   - ensure a label exists (look up or create)
 *   - add/remove labels on a message
 *   - create a draft reply
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Shared fetch wrapper — throws on non-2xx with a non-sensitive message. */
async function gmailFetch<T>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${GMAIL_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    // Only expose status + code — never expose the token or response body verbatim
    let errorCode = "UNKNOWN";
    try {
      const json = (await res.json()) as { error?: { message?: string; code?: number } };
      errorCode = json?.error?.message ?? String(res.status);
    } catch {
      errorCode = String(res.status);
    }
    throw new Error(`Gmail API error [${method} ${path}]: ${errorCode}`);
  }

  // Some endpoints return 204 No Content
  if (res.status === 204) {
    return {} as T;
  }

  return res.json() as Promise<T>;
}

/** Decode a base64url-encoded string to UTF-8 */
function decodeBase64Url(encoded: string): string {
  // base64url uses - and _ instead of + and /; pad to multiple of 4
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf-8");
}

/** Recursively find the first text/plain part in a MIME message payload */
interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

function extractPlainText(payload: GmailPart): string | null {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  /** Plain-text body; falls back to snippet if body is not available */
  bodyText: string;
  /** Short snippet provided by Gmail API */
  snippet: string;
}

export interface GmailLabel {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List message IDs matching a Gmail search query.
 * Returns an array of message IDs (strings); empty array if none found.
 *
 * @param query   Gmail search syntax, e.g. "is:unread in:inbox"
 * @param maxResults  Max messages to return (default 10, max 500)
 */
export async function listMessageIds(
  accessToken: string,
  query: string,
  maxResults = 10
): Promise<string[]> {
  interface ListResponse {
    messages?: Array<{ id: string }>;
    nextPageToken?: string;
  }

  const params = new URLSearchParams({
    q: query,
    maxResults: String(Math.min(maxResults, 500)),
  });

  const data = await gmailFetch<ListResponse>(
    accessToken,
    "GET",
    `/messages?${params.toString()}`
  );

  return (data.messages ?? []).map((m) => m.id);
}

/**
 * Fetch a single message and return parsed fields.
 * Decodes the base64url body; falls back to snippet if body is absent.
 */
export async function getMessage(
  accessToken: string,
  id: string
): Promise<GmailMessage> {
  interface RawMessage {
    id: string;
    threadId: string;
    snippet: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: GmailPart[];
      mimeType?: string;
    };
  }

  const raw = await gmailFetch<RawMessage>(
    accessToken,
    "GET",
    `/messages/${encodeURIComponent(id)}?format=full`
  );

  const headers = raw.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  const from = getHeader("From");
  const subject = getHeader("Subject");

  // Prefer plain-text body; fall back to snippet (never log full body)
  const bodyText =
    (raw.payload ? extractPlainText(raw.payload as GmailPart) : null) ??
    raw.snippet;

  return {
    id: raw.id,
    threadId: raw.threadId,
    from,
    subject,
    bodyText,
    snippet: raw.snippet,
  };
}

/**
 * Ensure a Gmail label exists by name. Returns the label ID.
 * Looks up existing labels first; creates the label only if absent.
 */
export async function ensureLabel(
  accessToken: string,
  name: string
): Promise<string> {
  interface LabelsListResponse {
    labels?: Array<{ id: string; name: string }>;
  }

  const listData = await gmailFetch<LabelsListResponse>(
    accessToken,
    "GET",
    "/labels"
  );

  const existing = (listData.labels ?? []).find((l) => l.name === name);
  if (existing) {
    return existing.id;
  }

  // Label doesn't exist — create it
  interface CreateLabelResponse {
    id: string;
    name: string;
  }

  const created = await gmailFetch<CreateLabelResponse>(
    accessToken,
    "POST",
    "/labels",
    {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }
  );

  return created.id;
}

/**
 * Add and/or remove labels from a Gmail message.
 */
export async function modifyMessageLabels(
  accessToken: string,
  id: string,
  {
    addLabelIds = [],
    removeLabelIds = [],
  }: { addLabelIds?: string[]; removeLabelIds?: string[] }
): Promise<void> {
  await gmailFetch(accessToken, "POST", `/messages/${encodeURIComponent(id)}/modify`, {
    addLabelIds,
    removeLabelIds,
  });
}

/**
 * Create a draft reply in the same thread.
 *
 * The draft is NEVER auto-sent (§2 — client sees drafts in their Gmail).
 * Builds a minimal RFC 822 message and base64url-encodes it.
 */
export async function createDraftReply(
  accessToken: string,
  {
    threadId,
    to,
    subject,
    bodyText,
  }: {
    threadId: string;
    to: string;
    subject: string;
    bodyText: string;
  }
): Promise<string> {
  // Build a minimal RFC 822 message
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const rfc822 = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    bodyText,
  ].join("\r\n");

  // base64url encode
  const encoded = Buffer.from(rfc822)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  interface DraftResponse {
    id: string;
  }

  const data = await gmailFetch<DraftResponse>(accessToken, "POST", "/drafts", {
    message: {
      threadId,
      raw: encoded,
    },
  });

  return data.id;
}
