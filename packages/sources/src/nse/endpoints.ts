/** www.nseindia.com 301-redirects to the .in host; calling it directly saves a hop. */
export const NSE_API_BASE = "https://www.nseindia.in/api";
export const NSE_ARCHIVES_BASE = "https://nsearchives.nseindia.com";

export const NSE_API_HEADERS: Record<string, string> = {
  Referer: "https://www.nseindia.com/",
};
