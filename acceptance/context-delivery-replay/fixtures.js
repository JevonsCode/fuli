// The synthetic preferences and messages each replay variant uses (rec#15
// D-29.4, D-29.11). `tiny` keeps the PR3 fixture byte for byte. `scaled` is
// generated from fixed seeds: 6–10 preferences of 120–400 UTF-8 bytes and
// 8–12 messages of 120–1500 bytes per scenario, mixed Chinese and English with
// code blocks. Both use the same scenarios, prompts, recovery windows and
// budgets; nothing is read from a real transcript or data directory.
import { syntheticPreference as rule } from '../../test-support/synthetic-context-session.js';

const bytes = text => Buffer.byteLength(text, 'utf8');

// mulberry32: a small fixed-seed generator, so every run produces the same text.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZH = ['导出接口需要保留分页游标', '先确认字段的单位再改', '这一步只读，不写数据', '回滚方案写在评审说明里',
  '按钮间距统一到网格', '错误信息要能定位到行', '不要在同一个提交里混入重构', '测试数据全部是合成的'];
const EN = ['keep the cursor stable across pages', 'state the unit of every field', 'this step is read-only',
  'write the rollback plan into the review', 'align the buttons to the grid', 'errors must point at a line',
  'do not mix a refactor into this commit', 'all test data is synthetic'];
const CODE = ['```js\nexport const pageSize = 50;\n```', '```sql\nSELECT id FROM orders WHERE id > ? LIMIT 50;\n```',
  '```css\n.toolbar { gap: 8px; }\n```', '```sh\nnpm run test:node\n```'];

// Whole fragments, Chinese and English in turn, up to a target byte length in
// [min, max]; a fragment is at most 60 bytes, so the target leaves room for
// the last one, and every text has at least one of each.
function text(random, prefix, min, max, { code = false } = {}) {
  const target = min + Math.floor(random() * (max - min - 60));
  const first = random() < 0.5 ? 0 : 1;
  let out = prefix;
  if (code) out += `\n${CODE[Math.floor(random() * CODE.length)]}\n`;
  for (let index = 0; index < 2 || bytes(out) < target; index++) {
    const pool = (index + first) % 2 ? EN : ZH;
    out += `${pool[Math.floor(random() * pool.length)]}${pool === ZH ? '。' : '. '}`;
  }
  return out;
}

const TINY_GENERAL = rule('tradeoffs', 'SYNTHETIC_GENERAL: state the tradeoff in one line.', {}, 'personality');
const TINY_SPACING = rule('spacing', 'SYNTHETIC_FRONTEND: use the 8px spacing grid.', { tasteDomain: 'frontend' });

export const TINY = Object.freeze({
  name: 'tiny',
  // An old-format confirmed judgment rule: no scene key, no constraint marker.
  boundary: [rule('no-unapproved-push', 'SYNTHETIC_BOUNDARY 未经批准不要强推共享分支', {}, 'judgment_preference')],
  general: [TINY_GENERAL],
  spacing: [TINY_SPACING],
  palette: [rule('palette', 'SYNTHETIC_DESIGN: prefer muted palettes.', { tasteDomain: 'design' })],
  radius: [rule('radius', 'SYNTHETIC_FRONTEND: 4px radius.', { tasteDomain: 'frontend' })],
  editedSpacing: [{ ...TINY_SPACING, instruction: 'SYNTHETIC_FRONTEND: use the 4px spacing grid.' }],
  // Scenarios that set no preferences carry these.
  defaults: [TINY_GENERAL],
  messages: {
    xxx: [['user', 'xxx'], ['assistant', 'Noted xxx.']],
    yyy: [['user', 'yyy'], ['assistant', 'Noted yyy.']],
    zzz: [['user', 'zzz'], ['assistant', 'Noted zzz.']],
    beforeCompaction: [['user', 'before compaction']],
    fromH: [['user', 'from H']],
    fromC: [['user', 'from C']],
    original: [['user', 'original']],
    stays: [['user', 'stays']]
  },
  replacement: 'replacement'
});

// Messages per group: each scenario that talks totals 8–12.
const SCALED_GROUPS = { xxx: 4, yyy: 4, zzz: 4, beforeCompaction: 5, fromH: 5, fromC: 5, original: 1, stays: 8 };

function scaled(seed) {
  const random = seeded(seed);
  const preferences = (key, count, qualifiers, aspect, marker) => Array.from({ length: count }, (_, index) =>
    rule(index ? `${key}-${index + 1}` : key, text(random, `SYNTHETIC_${marker} ${index + 1}: `, 120, 400), qualifiers, aspect));
  const boundary = preferences('no-unapproved-push', 2, {}, 'judgment_preference', 'BOUNDARY');
  const general = preferences('tradeoffs', 4, {}, 'personality', 'GENERAL');
  const spacing = preferences('spacing', 2, { tasteDomain: 'frontend' }, 'taste', 'FRONTEND');
  const palette = preferences('palette', 2, { tasteDomain: 'design' }, 'taste', 'DESIGN');
  const radius = preferences('radius', 1, { tasteDomain: 'frontend' }, 'taste', 'FRONTEND_ADDED');
  const editedSpacing = [{ ...spacing[0], instruction: text(random, 'SYNTHETIC_FRONTEND_EDITED: ', 120, 400) }, ...spacing.slice(1)];
  const messages = Object.fromEntries(Object.entries(SCALED_GROUPS).map(([group, count]) => [group,
    Array.from({ length: count }, (_, index) => {
      const role = index % 2 ? 'assistant' : 'user';
      return [role, text(random, `SYNTHETIC ${group} ${index + 1} (${role}): `, 120, 1500, { code: true })];
    })]));
  return Object.freeze({ name: 'scaled', boundary, general, spacing, palette, radius, editedSpacing,
    defaults: [...general, ...boundary], messages, replacement: text(random, 'SYNTHETIC replacement: ', 120, 1500, { code: true }) });
}

export const SCALED_SEED = 0x29_04_15;
export const FIXTURES = Object.freeze({ tiny: TINY, scaled: scaled(SCALED_SEED) });
