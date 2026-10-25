// Which clients the capture policy keeps from recording (rec#11 D-64). OpenCode
// was recorded as `other` until it got its own `opencode`, so a policy that
// turned `other` off and never names `opencode` keeps OpenCode off too: the
// rule src/agents/source-applications.js applies when FULI decides.
const LEGACY_ALIASES: Record<string, string> = { opencode: 'other' }

export function captureSourceOff(disabledSources: readonly string[], source: string) {
  const legacy = LEGACY_ALIASES[source]
  return disabledSources.includes(source) || (legacy !== undefined && disabledSources.includes(legacy))
}

// The policy's disabledSources after the person turns one client's recording
// on or off. Turning OpenCode on also lifts an `other` setting from before it
// had its own name, the only way that setting still kept OpenCode off.
export function withCaptureSource(disabledSources: readonly string[], source: string, capture: boolean) {
  const legacy = LEGACY_ALIASES[source]
  const others = disabledSources.filter(value => value !== source && !(capture && value === legacy))
  return capture ? others : [...others, source]
}
