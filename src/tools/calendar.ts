/**
 * Google Calendar tools. Moved out of src/index.ts during the plan 002
 * Phase 1 registry restructure. The three READ tools are listed on the
 * workspace endpoint since Phase 3; list_events gained a default window
 * (from now) because without one Google returns the OLDEST events first.
 * The write tools are listed nowhere until Phase 4. The attendee allowlist
 * check inside GmailAccountClient.createCalendarEvent / updateCalendarEvent
 * (ADR 004) is untouched here.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveReadAccounts, resolveWriteAccount } from '../accounts.js';
import { describeGoogleApiError, type CalendarEvent, type CalendarInfo } from '../gmail-client.js';
import {
  textResult,
  clamp,
  valueToString,
  valueToNumber,
  valueToBoolean,
  valueToStringArray,
  formatCalendarInfo,
  formatCalendarEvent,
  incompleteBanner,
} from './shared.js';
import type { ToolContext, ToolDefinition, ToolHandler, ToolModule } from './types.js';

export const listCalendarsTool: ToolDefinition = {
          name: 'list_calendars',
          description: 'List the calendars each account can see (primary and secondary), with their ids and time zones. Searches both accounts unless account is given; every calendar names its account.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Optional account id. Omit to list calendars for all enabled accounts.' },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const listEventsTool: ToolDefinition = {
          name: 'list_events',
          description: 'List or search events in a time window, soonest first, with explicit time zones, each naming its calendar. Defaults: both accounts, EVERY calendar shown in each account\'s Google Calendar sidebar (not just the primary), from now onward. Give time_min/time_max for a window (e.g. the coming week), calendar_id to read one calendar, query to search titles and descriptions.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Optional: "personal" or "tamu". Omit to query both.' },
              calendar_id: { type: 'string', description: 'Optional: one calendar id from list_calendars ("primary" for the main one). Omit to sweep every calendar shown in the sidebar. A secondary calendar\'s id belongs to one account -- pass that account too.' },
              time_min: { type: 'string', description: 'Earliest event end, RFC3339 with zone, e.g. "2026-09-21T00:00:00-05:00". Default: now, also when only time_max is given -- pass both for a window in the past.' },
              time_max: { type: 'string', description: 'Latest event start, RFC3339 with zone. On its own it means "from now until then".' },
              query: { type: 'string', description: 'Free-text search over titles, descriptions, locations and attendees.' },
              max_results: { type: 'number', description: 'Maximum events to return (1-250, default 25).' },
              single_events: { type: 'boolean', description: 'Expand recurring events into single instances (default true).', default: true },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const getEventTool: ToolDefinition = {
          name: 'get_event',
          description: 'Full details of one event: times with zone, location, description, attendees, link. Ids come from list_events.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              calendar_id: { type: 'string', description: 'Calendar ID.' },
              event_id: { type: 'string', description: 'Event ID.' },
            },
            required: ['account', 'calendar_id', 'event_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const createEventTool: ToolDefinition = {
          name: 'create_event',
          description:
            'Create a calendar event. Use start_date_time/end_date_time for timed events or start_date/end_date for all-day events. Attendees may only be the owner\'s own addresses (the send allowlist) -- anyone else is refused before the event is created, same boundary as mail. calendar_id for a secondary calendar (e.g. a testing calendar) comes from list_calendars and belongs to one account.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              calendar_id: { type: 'string', description: 'Calendar ID from list_calendars (default "primary"). A secondary calendar\'s id belongs to one account.' },
              summary: { type: 'string', description: 'Event title.' },
              description: { type: 'string', description: 'Event description.' },
              location: { type: 'string', description: 'Event location.' },
              start_date_time: { type: 'string', description: 'Start time as RFC3339, e.g. "2025-06-01T10:00:00".' },
              start_date: { type: 'string', description: 'All-day event start date as YYYY-MM-DD.' },
              end_date_time: { type: 'string', description: 'End time as RFC3339.' },
              end_date: { type: 'string', description: 'All-day event end date as YYYY-MM-DD.' },
              time_zone: { type: 'string', description: 'Time zone for start/end (e.g. "America/New_York").' },
              attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite. Only the owner\'s own allowlisted addresses are permitted; any other address is refused before anything is created.' },
              recurrence: { type: 'array', items: { type: 'string' }, description: 'RRULE strings, e.g. ["RRULE:FREQ=WEEKLY;COUNT=5"].' },
            },
            required: ['account', 'summary'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const updateEventTool: ToolDefinition = {
          name: 'update_event',
          description:
            'Change an existing calendar event -- only the fields provided are updated. Attendees may only be the owner\'s own addresses (the send allowlist) -- anyone else is refused before any change is made, same boundary as mail. calendar_id for a secondary calendar comes from list_calendars.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              calendar_id: { type: 'string', description: 'Calendar ID, from list_calendars or list_events.' },
              event_id: { type: 'string', description: 'Event ID, from list_events or get_event.' },
              summary: { type: 'string', description: 'New event title.' },
              description: { type: 'string', description: 'New event description.' },
              location: { type: 'string', description: 'New event location.' },
              start_date_time: { type: 'string', description: 'New start time as RFC3339.' },
              start_date: { type: 'string', description: 'New all-day start date.' },
              end_date_time: { type: 'string', description: 'New end time as RFC3339.' },
              end_date: { type: 'string', description: 'New all-day end date.' },
              time_zone: { type: 'string', description: 'Time zone for updated start/end.' },
              attendees: { type: 'array', items: { type: 'string' }, description: 'Replaces the full attendees list. Only the owner\'s own allowlisted addresses are permitted; any other address is refused before anything changes.' },
              status: { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'], description: 'Event status.' },
            },
            required: ['account', 'calendar_id', 'event_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
};
export const deleteEventTool: ToolDefinition = {
          name: 'delete_event',
          description:
            'Delete a calendar event. Recoverable from Google Calendar\'s trash for a limited time -- this is not permanent. Reads the event back afterward and reports the status Google now shows (normally "cancelled"; "gone" if Google has already removed it).',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              calendar_id: { type: 'string', description: 'Calendar ID, from list_calendars or list_events.' },
              event_id: { type: 'string', description: 'Event ID, from list_events or get_event.' },
            },
            required: ['account', 'calendar_id', 'event_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
};
export async function handleListCalendars(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const accountId = valueToString(rawArgs.account, '').trim() || undefined;
    const config = await ctx.loadConfig();
    const targetAccounts = resolveReadAccounts(config, accountId);

    const results = await Promise.all(
      targetAccounts.map(async (account) => {
        try {
          const client = await ctx.getClientForAccount(account);
          const cals = await client.listCalendars();
          return { cals, error: null as string | null };
        } catch (error) {
          return { cals: [] as CalendarInfo[], error: `${account.id}: ${(error as Error).message}` };
        }
      })
    );

    const all = results.flatMap((r) => r.cals);
    const errors = results.map((r) => r.error).filter((e): e is string => Boolean(e));

    const lines: string[] = [
      '# Google Calendars',
      '',
      ...incompleteBanner(errors),
      `**Scope**: ${accountId ? `account ${accountId}` : `all enabled accounts (${targetAccounts.length})`}`,
      `**Total**: ${all.length}`,
      '',
    ];

    all.forEach((cal, i) => {
      lines.push(`## ${i + 1}. ${cal.summary}${cal.primary ? ' (primary)' : ''}`);
      lines.push(formatCalendarInfo(cal));
      lines.push('');
    });

    return textResult(lines.join('\n'));
  }


export async function handleListEvents(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const accountId = valueToString(rawArgs.account, '').trim() || undefined;
    // No calendar_id means EVERY calendar the owner shows in the sidebar
    // (calendarList.selected), not just the primary: the owner's classes,
    // school and social calendars are separate calendars, so a primary-only
    // "what's on my calendar" understated the week (owner decision, plan 002
    // Phase 5). A hidden calendar -- the Google Testing one -- stays out.
    const calendarId = valueToString(rawArgs.calendar_id, '').trim() || undefined;
    let timeMin = valueToString(rawArgs.time_min, '').trim() || undefined;
    const timeMax = valueToString(rawArgs.time_max, '').trim() || undefined;
    // No lower bound would make Google return the oldest events on the
    // calendar first (orderBy startTime ascending) -- useless for "what's
    // coming up". Default the lower bound to now whenever it is missing, and
    // say so in the output. Until plan 002 Phase 5 this only happened when
    // BOTH bounds were missing: "this coming week" as time_max alone returned
    // a year-old grab-bag, exactly the trap the description promised against.
    let defaultedFromNow = false;
    if (!timeMin) {
      const now = new Date();
      if (timeMax && !Number.isNaN(Date.parse(timeMax)) && Date.parse(timeMax) < now.getTime()) {
        throw new Error(
          `time_max (${timeMax}) is in the past and time_min was not given. time_min defaults to now, ` +
            `so this window would be empty -- pass time_min as well to list a past window.`
        );
      }
      timeMin = now.toISOString();
      defaultedFromNow = true;
    }
    const query = valueToString(rawArgs.query, '').trim() || undefined;
    const maxResults = clamp(valueToNumber(rawArgs.max_results, 25), 1, 250);
    const singleEvents = valueToBoolean(rawArgs.single_events, true);

    const config = await ctx.loadConfig();
    const targetAccounts = resolveReadAccounts(config, accountId);

    const window = { timeMin, timeMax, query, maxResults, singleEvents };
    const results = await Promise.all(
      targetAccounts.map(async (account) => {
        const errors: string[] = [];
        let events: CalendarEvent[] = [];
        let calendarsSwept = 0;
        try {
          const client = await ctx.getClientForAccount(account);
          if (calendarId) {
            events = await client.listCalendarEvents(calendarId, window);
            calendarsSwept = 1;
          } else {
            const shown = (await client.listCalendars()).filter((cal) => cal.selected || cal.primary);
            calendarsSwept = shown.length;
            // One calendar failing must not hide the others: report it by
            // name and keep going, the same rule as a failing account.
            const perCalendar = await Promise.all(
              shown.map(async (cal) => {
                try {
                  const found = await client.listCalendarEvents(cal.id, window);
                  return found.map((event) => ({ ...event, calendarSummary: cal.summary }));
                } catch (error) {
                  errors.push(`${account.id}, calendar "${cal.summary}": ${(error as Error).message}`);
                  return [] as CalendarEvent[];
                }
              })
            );
            events = perCalendar.flat();
          }
        } catch (error) {
          errors.push(`${account.id}: ${(error as Error).message}`);
        }
        return { events, errors, calendarsSwept };
      })
    );

    // The same event can reach us twice: the tamu calendar is subscribed in
    // the personal sidebar, and a shared family calendar is in both. Keep
    // the first copy (accounts are listed in config order).
    const seen = new Set<string>();
    const merged = results
      .flatMap((r) => r.events)
      .filter((event) => {
        const key = `${event.calendarId}\u0000${event.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const at = a.start.dateTime || a.start.date || '';
        const bt = b.start.dateTime || b.start.date || '';
        return at < bt ? -1 : at > bt ? 1 : 0;
      });

    const errors = results.flatMap((r) => r.errors);
    const calendarsSwept = results.reduce((n, r) => n + r.calendarsSwept, 0);
    const returned = merged.slice(0, maxResults);

    const lines: string[] = [
      '# Calendar Events',
      '',
      ...incompleteBanner(errors),
      `**Scope**: ${accountId ? `account ${accountId}` : `all enabled accounts (${targetAccounts.length})`}`,
      `**Calendar**: ${calendarId ?? `every calendar shown in the sidebar (${calendarsSwept} swept)`}`,
    ];
    if (timeMin) lines.push(`**From**: ${timeMin}${defaultedFromNow ? ' (now -- no time_min given)' : ''}`);
    if (timeMax) lines.push(`**To**: ${timeMax}`);
    if (query) lines.push(`**Query**: ${query}`);
    lines.push(`**Total Found**: ${merged.length}`, `**Returned**: ${returned.length}`, '');

    returned.forEach((event, i) => {
      lines.push(`## ${i + 1}. ${event.summary}`);
      lines.push(formatCalendarEvent(event));
      lines.push('');
    });

    return textResult(lines.join('\n'));
  }


export async function handleGetEvent(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);
    const event = await client.getCalendarEvent(valueToString(rawArgs.calendar_id), valueToString(rawArgs.event_id));
    return textResult(['# Calendar Event', '', `**Title**: ${event.summary}`, '', formatCalendarEvent(event)].join('\n'));
  }


export async function handleCreateEvent(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);

    const tz = valueToString(rawArgs.time_zone, '').trim() || undefined;
    const startDT = valueToString(rawArgs.start_date_time, '').trim() || undefined;
    const startD = valueToString(rawArgs.start_date, '').trim() || undefined;
    const endDT = valueToString(rawArgs.end_date_time, '').trim() || undefined;
    const endD = valueToString(rawArgs.end_date, '').trim() || undefined;

    if (!startDT && !startD) throw new Error('Provide start_date_time or start_date.');
    if (!endDT && !endD) throw new Error('Provide end_date_time or end_date.');

    const calendarId = valueToString(rawArgs.calendar_id, 'primary').trim() || 'primary';
    let event: CalendarEvent;
    try {
      // send_notifications is not exposed on the schema (Phase 4 contract):
      // attendees here are only ever the owner's own allowlisted addresses,
      // so there is no third party whose notification is optional -- keep
      // the client's own default (true).
      event = await client.createCalendarEvent(calendarId, {
        summary: valueToString(rawArgs.summary),
        description: valueToString(rawArgs.description, '').trim() || undefined,
        location: valueToString(rawArgs.location, '').trim() || undefined,
        start: startDT ? { dateTime: startDT, timeZone: tz } : { date: startD },
        end: endDT ? { dateTime: endDT, timeZone: tz } : { date: endD },
        attendees: valueToStringArray(rawArgs.attendees),
        recurrence: valueToStringArray(rawArgs.recurrence),
      });
    } catch (error) {
      // createCalendarEvent doesn't wrap googleapis errors itself (only the
      // read paths in GmailAccountClient do) -- wrap here so a disabled API,
      // a lapsed token etc. produce the same sentences as everywhere else.
      // A SendNotAllowedError from the allowlist check passes through this
      // unchanged (it matches none of describeGoogleApiError's patterns).
      throw new Error(describeGoogleApiError(error, { service: 'Calendar', accountId: acc.id, fallback: 'Calendar event create failed.' }));
    }

    return textResult(['✅ Calendar event created.', '', formatCalendarEvent(event)].join('\n'));
  }


export async function handleUpdateEvent(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);

    const tz = valueToString(rawArgs.time_zone, '').trim() || undefined;
    const startDT = valueToString(rawArgs.start_date_time, '').trim() || undefined;
    const startD = valueToString(rawArgs.start_date, '').trim() || undefined;
    const endDT = valueToString(rawArgs.end_date_time, '').trim() || undefined;
    const endD = valueToString(rawArgs.end_date, '').trim() || undefined;

    const startUpdate = startDT ? { dateTime: startDT, timeZone: tz } : startD ? { date: startD } : undefined;
    const endUpdate = endDT ? { dateTime: endDT, timeZone: tz } : endD ? { date: endD } : undefined;

    const calendarId = valueToString(rawArgs.calendar_id);
    const eventId = valueToString(rawArgs.event_id);
    let event: CalendarEvent;
    try {
      event = await client.updateCalendarEvent(calendarId, eventId, {
        summary: valueToString(rawArgs.summary, '').trim() || undefined,
        description: valueToString(rawArgs.description, '').trim() || undefined,
        location: valueToString(rawArgs.location, '').trim() || undefined,
        start: startUpdate,
        end: endUpdate,
        attendees: rawArgs.attendees !== undefined ? valueToStringArray(rawArgs.attendees) : undefined,
        status: (valueToString(rawArgs.status, '').trim() || undefined) as string | undefined,
      });
    } catch (error) {
      throw new Error(describeGoogleApiError(error, { service: 'Calendar', accountId: acc.id, fallback: 'Calendar event update failed.' }));
    }

    return textResult(['✅ Calendar event updated.', '', formatCalendarEvent(event)].join('\n'));
  }


export async function handleDeleteEvent(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const calendarId = valueToString(rawArgs.calendar_id);
    const eventId = valueToString(rawArgs.event_id);
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);

    // Capture the title before deleting -- once Google returns the
    // "cancelled" tombstone (or 404/410s outright) there may be nothing
    // left to name the event by.
    let title: string;
    try {
      const before = await client.getCalendarEvent(calendarId, eventId);
      title = before.summary;
    } catch (error) {
      throw new Error(describeGoogleApiError(error, { service: 'Calendar', accountId: acc.id, fallback: 'Calendar event read failed.' }));
    }

    try {
      await client.deleteCalendarEvent(calendarId, eventId);
    } catch (error) {
      throw new Error(describeGoogleApiError(error, { service: 'Calendar', accountId: acc.id, fallback: 'Calendar event delete failed.' }));
    }

    // Read back rather than assuming the delete "worked" -- Google normally
    // keeps a "cancelled" tombstone for a while; report whatever it now
    // says, including an outright 404/410 as "gone", rather than a status
    // this tool invented.
    let status: string;
    try {
      const raw = client.rawApis();
      const after = await raw.calendar.events.get({ calendarId, eventId });
      status = after.data.status ?? '(unknown)';
    } catch (error) {
      const err = error as { code?: number | string; response?: { status?: number } };
      const code = typeof err.code === 'string' ? Number(err.code) : err.code ?? err.response?.status;
      if (code === 404 || code === 410) {
        status = 'gone';
      } else {
        throw new Error(describeGoogleApiError(error, { service: 'Calendar', accountId: acc.id, fallback: 'Calendar event read-back after delete failed.' }));
      }
    }

    return textResult(`✅ Event "${title}" deleted from calendar ${calendarId} in account ${acc.id} -- Google now reports its status as "${status}" (recoverable from Calendar's trash for a limited time).`);
  }

export const definitions: ToolDefinition[] = [
  listCalendarsTool,
  listEventsTool,
  getEventTool,
  createEventTool,
  updateEventTool,
  deleteEventTool,
];

export const handlers: Record<string, ToolHandler> = {
  list_calendars: handleListCalendars,
  list_events: handleListEvents,
  get_event: handleGetEvent,
  create_event: handleCreateEvent,
  update_event: handleUpdateEvent,
  delete_event: handleDeleteEvent,
};

const calendarModule: ToolModule = { definitions, handlers };
export default calendarModule;
