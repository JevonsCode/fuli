import type { BackdropDrift } from './growing-backdrop'

/**
 * One backdrop per dock destination (Jevons, 11-02: 这几个背景都不一样，但整体
 * 设计的一致性要有). Every motif is abstract and draws from one palette, the
 * theme's gold, success green and ink, at the faint strength of the first
 * backdrop's gold glow, so text over it reads the same on every page. Each
 * paints once as CSS gradients and moves only by the shared stepped pose
 * (lib/growing-backdrop) along its own short drift.
 */
export interface PageBackdrop { key: string; background: string; drift: BackdropDrift }

type Tone = 'gold' | 'success' | 'ink'
const TONES: Record<Tone, string> = { gold: 'var(--color-gold)', success: 'var(--color-success)', ink: 'var(--color-ink)' }

const tint = (tone: Tone, percent: number) => `color-mix(in srgb, ${TONES[tone]} ${percent}%, transparent)`
const glow = (tone: Tone, percent: number, size: string, at: string) =>
  `radial-gradient(${size} at ${at}, ${tint(tone, percent)}, transparent 70%)`
const ring = (tone: Tone, percent: number, at: string, radius: number) =>
  `radial-gradient(circle at ${at}, transparent ${radius - 3}%, ${tint(tone, percent)} ${radius}%, transparent ${radius + 3}%)`
const band = (tone: Tone, percent: number, from: number, to: number) =>
  `linear-gradient(to top, transparent ${from}%, ${tint(tone, percent)} ${(from + to) / 2}%, transparent ${to}%)`
const point = (tone: Tone, percent: number, at: string) => `radial-gradient(circle 3px at ${at}, ${tint(tone, percent)}, transparent)`

// The first backdrop: two glows that swell out and back. Settings and any page
// outside the dock keep it.
const GROWTH: PageBackdrop = {
  key: 'growth',
  background: [glow('gold', 13, '42% 46%', '18% 88%'), glow('success', 8, '38% 42%', '84% 14%')].join(', '),
  drift: { from: { x: 0, y: 1.5, scale: 1 }, to: { x: 1, y: -2, scale: 1.07 } },
}

const MOTIFS: readonly PageBackdrop[] = [
  // 工作台: a low warm glow rising like a slow sunrise.
  {
    key: 'constellation',
    background: [glow('gold', 13, '60% 50%', '32% 100%'), glow('gold', 7, '40% 36%', '70% 96%'), glow('success', 6, '36% 40%', '84% 12%')].join(', '),
    drift: { from: { x: 0, y: 2, scale: 1 }, to: { x: 0.5, y: -1.5, scale: 1.06 } },
  },
  // FLAs: a few soft orbs gathered together, breathing.
  {
    key: 'agents',
    background: [
      glow('gold', 10, '24% 30%', '30% 64%'), glow('success', 7, '22% 28%', '45% 52%'),
      glow('gold', 8, '20% 26%', '60% 66%'), glow('success', 6, '22% 28%', '74% 50%'),
    ].join(', '),
    drift: { from: { x: -0.5, y: 0.5, scale: 1 }, to: { x: 0.5, y: -0.5, scale: 1.04 } },
  },
  // 圆桌: ripples spreading from one centre.
  {
    key: 'chat',
    background: [
      glow('gold', 6, '24% 28%', '50% 58%'),
      ring('gold', 8, '50% 58%', 18), ring('success', 6, '50% 58%', 30), ring('gold', 5, '50% 58%', 42),
    ].join(', '),
    drift: { from: { x: 0, y: 0.5, scale: 1 }, to: { x: 0, y: -0.5, scale: 1.06 } },
  },
  // 沉淀: layered bands settling at the bottom.
  {
    key: 'memory',
    background: [
      `linear-gradient(to top, ${tint('gold', 10)}, transparent 18%)`,
      band('success', 6, 20, 30), band('gold', 6, 34, 42), band('ink', 3, 46, 52),
    ].join(', '),
    drift: { from: { x: 0, y: -1.5, scale: 1 }, to: { x: 0, y: 1, scale: 1.02 } },
  },
  // 项目: a faint constellation of points.
  {
    key: 'projects',
    background: [
      point('gold', 12, '18% 30%'), point('ink', 8, '27% 44%'), point('gold', 10, '38% 26%'), point('ink', 8, '52% 38%'),
      point('gold', 12, '64% 22%'), point('ink', 8, '74% 42%'), point('gold', 10, '84% 30%'),
      glow('success', 6, '38% 42%', '80% 16%'),
    ].join(', '),
    drift: { from: { x: -1, y: 0.5, scale: 1 }, to: { x: 0.5, y: -1, scale: 1.03 } },
  },
]

/** The backdrop for a destination key (shell.destinations); anything else keeps the first backdrop. */
export function pageBackdrop(destination: string | undefined): PageBackdrop {
  return MOTIFS.find(motif => motif.key === destination) ?? GROWTH
}
