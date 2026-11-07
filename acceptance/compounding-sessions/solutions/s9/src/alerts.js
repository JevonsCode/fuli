// On-call alert titles: `[tidewater] ` and the channel name in upper case.
export function alertTitle(channelName) {
  return `[tidewater] ${String(channelName).toUpperCase()}`;
}
