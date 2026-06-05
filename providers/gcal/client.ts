/**
 * providers/gcal/client.ts — Google Calendar API v3 helpers (meeting prep).
 *
 * Thin fetch wrappers around the Calendar API. Each function takes a plaintext
 * accessToken (decrypted in-memory by the caller via getValidAccessToken).
 *
 * Security:
 * - Never log the accessToken (§7.2)
 * - Never log full event details (titles/descriptions may contain PII)
 * - All calls wrapped: throw non-sensitive errors to the caller
 *
 * Covers exactly what meeting-prep needs (§7.5 — minimum):
 *   - list upcoming events in a time window
 *   - patch an event's description (write prep notes back) + set a private
 *     extended property used as the dedupe marker
 */

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

/**
 * Private extended-property key used to mark an event as already prepped, so we
 * never generate prep notes for the same event twice (§8.4 dedupe). The value
 * is the prompt version, so a future prompt bump could opt to re-prep.
 */
export const PREP_MARKER_KEY = "drixxoMeetingPrep";
export const PREP_MARKER_VALUE = "v1";

// ---------------------------------------------------------------------------
// Internal fetch wrapper — throws on non-2xx with a non-sensitive message.
// ---------------------------------------------------------------------------

async function gcalFetch<T>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${GCAL_BASE}${path}`;
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
    // Only expose status + code — never the token or response body verbatim.
    let errorCode = "UNKNOWN";
    try {
      const json = (await res.json()) as { error?: { message?: string } };
      errorCode = json?.error?.message ?? String(res.status);
    } catch {
      errorCode = String(res.status);
    }
    throw new Error(`Calendar API error [${method} ${path}]: ${errorCode}`);
  }

  if (res.status === 204) {
    return {} as T;
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: string;
  /** Event title ("summary" in the Calendar API); may be empty. */
  summary: string;
  /** Existing event description; "" if none. */
  description: string;
  /** Start as an ISO string (dateTime for timed events, date for all-day). */
  startISO: string;
  /** Attendee email addresses (excludes resource rooms where possible). */
  attendees: string[];
  /** True if this event already carries our prep dedupe marker (§8.4). */
  hasPrep: boolean;
}

// Raw shapes from the Calendar API (only the fields we read).
interface RawEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; resource?: boolean }>;
  extendedProperties?: { private?: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List events on `calendarId` between timeMinISO and timeMaxISO.
 * Uses singleEvents=true + orderBy=startTime so recurring events are expanded
 * into individual instances. Cancelled events are filtered out.
 *
 * @param calendarId  e.g. "primary"
 * @param maxResults  cap on events returned (default 25)
 */
export async function listUpcomingEvents(
  accessToken: string,
  {
    calendarId,
    timeMinISO,
    timeMaxISO,
    maxResults = 25,
  }: {
    calendarId: string;
    timeMinISO: string;
    timeMaxISO: string;
    maxResults?: number;
  }
): Promise<CalendarEvent[]> {
  interface ListResponse {
    items?: RawEvent[];
  }

  const params = new URLSearchParams({
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(maxResults, 250)),
  });

  const data = await gcalFetch<ListResponse>(
    accessToken,
    "GET",
    `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`
  );

  return (data.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      id: e.id,
      summary: e.summary ?? "",
      description: e.description ?? "",
      startISO: e.start?.dateTime ?? e.start?.date ?? "",
      attendees: (e.attendees ?? [])
        .filter((a) => !a.resource && typeof a.email === "string")
        .map((a) => a.email as string),
      hasPrep: e.extendedProperties?.private?.[PREP_MARKER_KEY] != null,
    }));
}

/**
 * Patch an event's description (to append prep notes) and stamp the private
 * extended property that marks it as prepped (dedupe marker).
 *
 * PATCH merges, so we only send the fields we change. extendedProperties.private
 * keys are merged with existing ones by the Calendar API, so the marker is
 * added without clobbering other private properties.
 *
 * @param newDescription  the full new description to store on the event
 */
export async function patchEventPrep(
  accessToken: string,
  {
    calendarId,
    eventId,
    newDescription,
  }: {
    calendarId: string;
    eventId: string;
    newDescription: string;
  }
): Promise<void> {
  await gcalFetch(
    accessToken,
    "PATCH",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      description: newDescription,
      extendedProperties: {
        private: { [PREP_MARKER_KEY]: PREP_MARKER_VALUE },
      },
    }
  );
}
