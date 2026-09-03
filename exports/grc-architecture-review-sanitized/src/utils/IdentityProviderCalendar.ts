let connectionSettings: any;

async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }
  
  const hostname = process.env.HostingPlatform_CONNECTORS_HOSTNAME;
  const xHostingPlatformToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xHostingPlatformToken) {
    throw new Error('X_HostingPlatform_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    '<REDACTED_URL_SCHEME>' + hostname + '/api/v2/connection?include_secrets=true&connector_names=IdentityProvider-calendar',
    {
      headers: {
        'Accept': 'application/json',
        'X_HostingPlatform_TOKEN': xHostingPlatformToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('IdentityProvider Calendar not connected');
  }
  return accessToken;
}

const CALENDAR_API_BASE = '<REDACTED_URL>';

async function calendarApiRequest(path: string, params?: Record<string, string>) {
  const accessToken = await getAccessToken();
  const url = new URL(`${CALENDAR_API_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Calendar API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  attendees: string[];
  status: string;
  organizer?: string;
  location?: string;
  meetingLink?: string;
}

export async function fetchCalendarEvents(
  startDate: Date,
  endDate: Date,
  calendarId: string = 'primary'
): Promise<CalendarEvent[]> {
  const data = await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    }
  );

  const events = data.items || [];
  
  return events.map((event: any) => ({
    id: event.id || '',
    summary: event.summary || 'No Title',
    description: event.description,
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    attendees: (event.attendees || []).map((a: any) => a.email),
    status: event.status || 'confirmed',
    organizer: event.organizer?.email,
    location: event.location,
    meetingLink: event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri,
  }));
}

export async function getCalendarList(): Promise<{ id: string; summary: string }[]> {
  const data = await calendarApiRequest('/users/me/calendarList');
  
  return (data.items || []).map((cal: any) => ({
    id: cal.id || '',
    summary: cal.summary || 'Unnamed Calendar',
  }));
}
