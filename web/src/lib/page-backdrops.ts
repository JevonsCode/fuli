/**
 * One backdrop per dock destination (Jevons, 11-02: 这几个背景都不一样，但整体
 * 设计的一致性要有). Every motif is abstract and draws from one palette: the
 * theme's light glow gold and jade, with a trace of ink. The glows are strong
 * enough that their breathing reads at a glance (11-02: 背景不动) and light
 * enough that muted text over any of them keeps 4.5:1. Each paints once as CSS
 * gradients split over two or three layers; the layers drift and breathe on
 * their own long clocks (GrowingBackdrop.vue), so the motif stays alive
 * without ever visibly looping.
 */
export interface PageBackdrop { key: string; layers: readonly string[] }

type Tone = 'gold' | 'success' | 'ink'
const TONES: Record<Tone, string> = { gold: 'var(--color-glow-gold)', success: 'var(--color-glow-success)', ink: 'var(--color-ink)' }

const tint = (tone: Tone, percent: number) => `color-mix(in srgb, ${TONES[tone]} ${percent}%, transparent)`
const glow = (tone: Tone, percent: number, size: string, at: string) =>
  `radial-gradient(${size} at ${at}, ${tint(tone, percent)}, transparent 70%)`
const ring = (tone: Tone, percent: number, at: string, radius: number) =>
  `radial-gradient(circle at ${at}, transparent ${radius - 3}%, ${tint(tone, percent)} ${radius}%, transparent ${radius + 3}%)`
const band = (tone: Tone, percent: number, from: number, to: number) =>
  `linear-gradient(to top, transparent ${from}%, ${tint(tone, percent)} ${(from + to) / 2}%, transparent ${to}%)`
const point = (tone: Tone, percent: number, at: string) => `radial-gradient(circle 3px at ${at}, ${tint(tone, percent)}, transparent)`

// The first backdrop: two glows that swell and ebb. Settings and any page
// outside the dock keep it.
const GROWTH: PageBackdrop = {
  key: 'growth',
  layers: [glow('gold', 40, '42% 46%', '18% 88%'), glow('success', 42, '38% 42%', '84% 14%')],
}

const MOTIFS: readonly PageBackdrop[] = [
  // 工作台: a low warm glow rising like a slow sunrise.
  {
    key: 'constellation',
    layers: [glow('gold', 40, '60% 50%', '32% 100%'), glow('gold', 28, '40% 36%', '70% 96%'), glow('success', 40, '36% 40%', '84% 12%')],
  },
  // FLAs: a few soft orbs gathered together, breathing.
  {
    key: 'agents',
    layers: [
      glow('gold', 36, '24% 30%', '30% 64%'),
      [glow('success', 34, '22% 28%', '45% 52%'), glow('success', 32, '22% 28%', '74% 50%')].join(', '),
      glow('gold', 32, '20% 26%', '60% 66%'),
    ],
  },
  // 圆桌: ripples spreading from one centre, each ring on its own breath.
  {
    key: 'chat',
    layers: [
      [glow('gold', 20, '24% 28%', '50% 58%'), ring('gold', 40, '50% 58%', 18)].join(', '),
      ring('success', 40, '50% 58%', 30),
      ring('gold', 34, '50% 58%', 42),
    ],
  },
  // 沉淀: layered bands settling at the bottom.
  {
    key: 'memory',
    layers: [
      `linear-gradient(to top, ${tint('gold', 40)}, transparent 18%)`,
      [band('success', 38, 20, 30), band('ink', 3, 46, 52)].join(', '),
      band('gold', 36, 34, 42),
    ],
  },
  // 项目: a faint constellation of points that twinkle against each other.
  {
    key: 'projects',
    layers: [
      [point('gold', 44, '18% 30%'), point('gold', 40, '38% 26%'), point('gold', 44, '64% 22%'), point('gold', 40, '84% 30%')].join(', '),
      glow('success', 40, '38% 42%', '80% 16%'),
      [point('ink', 5, '27% 44%'), point('ink', 5, '52% 38%'), point('ink', 5, '74% 42%')].join(', '),
    ],
  },
]

/** The backdrop for a destination key (shell.destinations); anything else keeps the first backdrop. */
export function pageBackdrop(destination: string | undefined): PageBackdrop {
  return MOTIFS.find(motif => motif.key === destination) ?? GROWTH
}
