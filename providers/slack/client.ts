/**
 * providers/slack/client.ts — Slack Web API client helpers (§6.1, M4).
 *
 * Provides thin wrappers around Slack Web API endpoints used by automations.
 * All calls use Bearer auth with the stored (decrypted) bot access token.
 *
 * Security:
 *   - Never log the accessToken parameter (§7.2).
 *   - Slack's API returns HTTP 200 even for logical errors; we check the
 *     `ok` boolean in the response body and throw a non-sensitive error on
 *     failure so the Run can record it without leaking internal details.
 *   - All network calls are wrapped in try/catch.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlackAPIResponse {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Sends a POST request to a Slack Web API endpoint using Bearer auth.
 * Throws a non-sensitive error if the HTTP request fails or Slack returns ok=false.
 *
 * @param accessToken  The bot access token (plaintext, decrypted in-memory only).
 *                     Never logged.
 * @param method       The Slack API method name, e.g. "chat.postMessage".
 * @param body         JSON body to include in the request.
 */
async function slackAPIPost(
  accessToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<SlackAPIResponse> {
  const url = `${SLACK_API_BASE}/${method}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        // Token is carried in the Authorization header; never in the URL or body.
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, etc.)
    throw new Error(
      `[slack/client] Network error calling Slack API method '${method}': ${
        err instanceof Error ? err.message : "unknown network error"
      }`
    );
  }

  if (!response.ok) {
    // HTTP-level failure (4xx/5xx) — unusual for Slack but handle it.
    throw new Error(
      `[slack/client] HTTP ${response.status} from Slack API method '${method}'.`
    );
  }

  let data: SlackAPIResponse;
  try {
    data = (await response.json()) as SlackAPIResponse;
  } catch {
    throw new Error(
      `[slack/client] Invalid JSON in Slack API response for method '${method}'.`
    );
  }

  // Slack always returns HTTP 200 and signals errors in the body's ok/error fields.
  if (!data.ok) {
    // Log a non-sensitive marker (the Slack error code, not the token or content).
    const errCode = data.error ?? "unknown_error";
    throw new Error(
      `[slack/client] Slack API method '${method}' failed with error: ${errCode}`
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Posts a plain-text message to a Slack channel.
 *
 * @param accessToken  Decrypted bot access token — never log this value (§7.2).
 * @param channel      Channel ID (e.g. "C0123ABCD") or channel name (e.g. "#general").
 *                     Channel ID is preferred — channel names can be renamed.
 * @param text         The message text to post.
 *
 * Throws a non-sensitive error if the call fails. Callers must try/catch and
 * record the error on the Run (§10).
 */
export async function postMessage(
  accessToken: string,
  channel: string,
  text: string
): Promise<void> {
  await slackAPIPost(accessToken, "chat.postMessage", { channel, text });
}
