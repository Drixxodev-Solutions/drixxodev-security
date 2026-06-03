/**
 * lib/alerts.ts — Operator alert delivery (§6.5, M3)
 *
 * Sends structured alerts to the operator when usage thresholds are crossed.
 *
 * M3: alerts are delivered as prominent console.warn / console.error messages.
 * The function is safe to call from both the Next.js runtime and the worker process.
 *
 * TODO(M4): deliver via email/Slack using the channel configured in
 * OPERATOR_ALERT_EMAIL (email) or OPERATOR_SLACK_WEBHOOK (Slack). The
 * structured `alert` object maps directly to an email subject+body or a
 * Slack Block Kit message. No secrets are emitted in any log or alert body.
 *
 * Security:
 * - Never include prompt content, access tokens, or API keys in alert payloads.
 * - `details` must only carry non-sensitive metadata (IDs, counts, costs).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertType = "usage_80" | "overage_pause" | "daily_spend";

export interface OperatorAlert {
  /** Discriminator for alert routing / filtering */
  type: AlertType;
  /** Client ID if alert is client-scoped; omit for operator-level alerts */
  clientId?: string;
  /** Human-readable summary of the alert */
  message: string;
  /** Non-sensitive structured metadata (counts, costs, dates — never tokens/keys) */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * notifyOperator — emit a structured operator alert.
 *
 * Always safe to call: never throws. If future delivery channels (email, Slack)
 * fail, the error is caught and logged without propagating to the caller.
 *
 * @param alert - The alert payload. Must never contain secrets or PII.
 */
export function notifyOperator(alert: OperatorAlert): void {
  const payload = {
    alertType: alert.type,
    ...(alert.clientId ? { clientId: alert.clientId } : {}),
    message: alert.message,
    ...(alert.details ? { details: alert.details } : {}),
    issuedAt: new Date().toISOString(),
  };

  // Use console.error for overage_pause (action taken) and usage_80/daily_spend as warn
  const logFn =
    alert.type === "overage_pause" ? console.error : console.warn;

  logFn(
    `[OPERATOR ALERT] type=${alert.type}` +
      (alert.clientId ? ` client=${alert.clientId}` : "") +
      ` — ${alert.message}`,
    // Attach structured payload as second arg for log-aggregators (e.g. Datadog JSON)
    JSON.stringify(payload)
  );

  // TODO(M4): deliver via configured channel.
  // Example seam:
  //   const email = process.env.OPERATOR_ALERT_EMAIL;
  //   if (email) { sendAlertEmail(email, alert).catch(deliveryErrHandler); }
  //   const slackWebhook = process.env.OPERATOR_SLACK_WEBHOOK;
  //   if (slackWebhook) { postSlackAlert(slackWebhook, alert).catch(deliveryErrHandler); }
}
