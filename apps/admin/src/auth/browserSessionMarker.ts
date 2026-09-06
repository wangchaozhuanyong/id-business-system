export const BROWSER_SESSION_MARKER_KEY = 'apple_business_browser_session_marker';

export interface BrowserSessionMarker {
  credentialId: string;
  signedOut: boolean;
  sessionId?: string;
}

export function readBrowserSessionMarker(): BrowserSessionMarker | null {
  try {
    const marker = JSON.parse(localStorage.getItem(BROWSER_SESSION_MARKER_KEY) ?? 'null');
    return marker &&
      typeof marker.credentialId === 'string' &&
      marker.credentialId &&
      typeof marker.signedOut === 'boolean'
      ? {
          credentialId: marker.credentialId,
          signedOut: marker.signedOut,
          ...(typeof marker.sessionId === 'string' ? { sessionId: marker.sessionId } : {})
        }
      : null;
  } catch {
    return null;
  }
}

export function readTokenSessionId(token: string): string | undefined {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    // This unverified ID only rejects stale cookie responses; the API authorizes every restore.
    return typeof payload.jti === 'string' && payload.jti ? payload.jti : undefined;
  } catch {
    return undefined;
  }
}

export function writeBrowserSessionMarker(marker: BrowserSessionMarker) {
  try {
    // Only an opaque identity marker is shared; never a token or user profile.
    localStorage.setItem(BROWSER_SESSION_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // Session storage and server validation remain usable without shared storage.
  }
}
