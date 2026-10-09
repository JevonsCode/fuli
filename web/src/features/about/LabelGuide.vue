<script setup lang="ts">
import { computed } from 'vue'

import { t } from '@/i18n'

const dimensions = computed(() => [
  {
    key: 'profile',
    title: t('about.dimensions.profile.title'),
    question: t('about.dimensions.profile.question'),
    timing: t('about.dimensions.profile.timing'),
  },
  {
    key: 'origin',
    title: t('about.dimensions.origin.title'),
    question: t('about.dimensions.origin.question'),
    timing: t('about.dimensions.origin.timing'),
  },
  {
    key: 'confirmation',
    title: t('about.dimensions.confirmation.title'),
    question: t('about.dimensions.confirmation.question'),
    timing: t('about.dimensions.confirmation.timing'),
  },
])

const profiles = computed(() => [
  {
    key: 'taste',
    label: t('about.profiles.taste.label'),
    short: t('about.profiles.taste.short'),
    description: t('about.profiles.taste.description'),
  },
  {
    key: 'personality',
    label: t('about.profiles.personality.label'),
    short: t('about.profiles.personality.short'),
    description: t('about.profiles.personality.description'),
  },
  {
    key: 'judgment',
    label: t('about.profiles.judgment.label'),
    short: t('about.profiles.judgment.short'),
    description: t('about.profiles.judgment.description'),
  },
])

const quadrants = computed(() => [
  {
    key: 'known-unknown',
    label: t('about.quadrants.knownUnknown.label'),
    coordinate: t('about.quadrants.knownUnknown.coordinate'),
    description: t('about.quadrants.knownUnknown.description'),
  },
  {
    key: 'known-known',
    label: t('about.quadrants.knownKnown.label'),
    coordinate: t('about.quadrants.knownKnown.coordinate'),
    description: t('about.quadrants.knownKnown.description'),
  },
  {
    key: 'unknown-unknown',
    label: t('about.quadrants.unknownUnknown.label'),
    coordinate: t('about.quadrants.unknownUnknown.coordinate'),
    description: t('about.quadrants.unknownUnknown.description'),
  },
  {
    key: 'unknown-known',
    label: t('about.quadrants.unknownKnown.label'),
    coordinate: t('about.quadrants.unknownKnown.coordinate'),
    description: t('about.quadrants.unknownKnown.description'),
  },
])

const statuses = computed(() => [
  {
    key: 'pending',
    label: t('about.statuses.pending.label'),
    description: t('about.statuses.pending.description'),
    rule: t('about.statuses.pending.rule'),
  },
  {
    key: 'agent-confirmed',
    label: t('about.statuses.agentConfirmed.label'),
    description: t('about.statuses.agentConfirmed.description'),
    rule: t('about.statuses.agentConfirmed.rule'),
  },
  {
    key: 'confirmed',
    label: t('about.statuses.confirmed.label'),
    description: t('about.statuses.confirmed.description'),
    rule: t('about.statuses.confirmed.rule'),
  },
])
</script>

<template>
  <section class="label-guide" :aria-label="t('about.labelsAria')">
    <div class="label-dimension-strip">
      <article v-for="dimension in dimensions" :key="dimension.key" :data-dimension="dimension.key">
        <i aria-hidden="true" />
        <dl>
          <dt>{{ dimension.title }}</dt>
          <dd>
            {{ dimension.question }}
            <small>{{ dimension.timing }}</small>
          </dd>
        </dl>
      </article>
    </div>

    <div class="label-guide-sheet">
      <section class="label-guide-section profile-guide">
        <header>
          <span>{{ t('about.sections.profile.index') }}</span>
          <div>
            <h3>{{ t('about.sections.profile.title') }}</h3>
            <p>{{ t('about.sections.profile.meta') }}</p>
          </div>
        </header>
        <dl class="label-definition-list">
          <div v-for="profile in profiles" :key="profile.key" class="label-definition-row">
            <dt>
              <span class="label-token profile-token" :data-kind="profile.key">{{ profile.label }}</span>
            </dt>
            <dd>
              <strong>{{ profile.short }}</strong>
              <p>{{ profile.description }}</p>
            </dd>
          </div>
        </dl>
      </section>

      <section class="label-guide-section quadrant-guide">
        <header>
          <span>{{ t('about.sections.origin.index') }}</span>
          <div>
            <h3>{{ t('about.sections.origin.title') }}</h3>
            <p>{{ t('about.sections.origin.meta') }}</p>
          </div>
        </header>
        <div class="quadrant-explainer">
          <div class="quadrant-y-axis" aria-hidden="true">
            <span>{{ t('about.quadrants.aware') }}</span>
            <strong>{{ t('about.quadrants.awareness') }}</strong>
            <span>{{ t('about.quadrants.unaware') }}</span>
          </div>
          <div class="quadrant-grid" role="group" :aria-label="t('about.sections.origin.title')">
            <article v-for="quadrant in quadrants" :key="quadrant.key" :data-quadrant="quadrant.key">
              <span>{{ quadrant.coordinate }}</span>
              <strong>{{ quadrant.label }}</strong>
              <p>{{ quadrant.description }}</p>
            </article>
          </div>
          <div class="quadrant-x-axis" aria-hidden="true">
            <span>{{ t('about.quadrants.unmastered') }}</span>
            <strong>{{ t('about.quadrants.mastery') }}</strong>
            <span>{{ t('about.quadrants.mastered') }}</span>
          </div>
          <div class="quadrant-notes">
            <p>{{ t('about.quadrants.immutable') }}</p>
            <p>{{ t('about.quadrants.unclassified') }}</p>
          </div>
        </div>
      </section>

      <section class="label-guide-section confirmation-guide">
        <header>
          <span>{{ t('about.sections.confirmation.index') }}</span>
          <div>
            <h3>{{ t('about.sections.confirmation.title') }}</h3>
            <p>{{ t('about.sections.confirmation.meta') }}</p>
          </div>
        </header>
        <div class="status-table-wrap">
          <table class="status-definition-table">
            <thead>
              <tr>
                <th scope="col">{{ t('about.sections.confirmation.title') }}</th>
                <th scope="col">{{ t('about.statuses.descriptionHeader') }}</th>
                <th scope="col">{{ t('about.statuses.entryCondition') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="status in statuses" :key="status.key" class="status-definition-row">
                <th scope="row">
                  <span class="label-token status-token" :data-status="status.key">{{ status.label }}</span>
                </th>
                <td :data-label="t('about.statuses.descriptionHeader')">{{ status.description }}</td>
                <td :data-label="t('about.statuses.entryCondition')"><strong>{{ status.rule }}</strong></td>
              </tr>
            </tbody>
          </table>
          <div class="status-boundaries">
            <p>{{ t('about.statuses.usageBoundary') }}</p>
            <p>{{ t('about.statuses.resetBoundary') }}</p>
          </div>
        </div>
      </section>

      <section class="label-example">
        <div>
          <span>{{ t('about.example.title') }}</span>
          <strong>{{ t('about.example.item') }}</strong>
        </div>
        <div class="label-example-tags" aria-hidden="true">
          <span class="label-token profile-token" data-kind="taste">{{ t('about.example.profile') }}</span>
          <span class="label-token origin-token">{{ t('about.example.origin') }}</span>
          <span class="label-token status-token" data-status="confirmed">{{ t('about.example.status') }}</span>
        </div>
        <p>{{ t('about.example.description') }}</p>
      </section>

      <p class="label-all-note">{{ t('about.allFilter') }}</p>
    </div>
  </section>
</template>

<style scoped>
.label-dimension-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-block: 1px solid var(--color-border);
}

.label-dimension-strip article {
  min-width: 0;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 11px;
  padding: 16px 18px;
}

.label-dimension-strip article + article { border-left: 1px solid var(--color-border); }

.label-dimension-strip i {
  position: relative;
  width: 22px;
  height: 22px;
  border: 1px solid var(--color-border-strong);
  border-radius: 6px;
}

.label-dimension-strip i::before,
.label-dimension-strip i::after {
  position: absolute;
  content: '';
}

.label-dimension-strip [data-dimension="profile"] i::before {
  inset: 5px;
  border: 1.5px solid var(--color-muted);
  border-radius: 50%;
}

.label-dimension-strip [data-dimension="profile"] i::after {
  top: 2px;
  right: 2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-danger);
}

.label-dimension-strip [data-dimension="origin"] i::before {
  inset: 4px;
  border-right: 1px solid var(--color-muted);
  border-bottom: 1px solid var(--color-muted);
}

.label-dimension-strip [data-dimension="origin"] i::after {
  top: 4px;
  right: 4px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-muted);
}

.label-dimension-strip [data-dimension="confirmation"] i::before {
  top: 5px;
  left: 5px;
  width: 11px;
  height: 6px;
  border-left: 2px solid var(--color-muted);
  border-bottom: 2px solid var(--color-muted);
  transform: rotate(-45deg);
}

.label-dimension-strip dl,
.label-dimension-strip dt,
.label-dimension-strip dd {
  margin: 0;
}

.label-dimension-strip dt {
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 680;
}

.label-dimension-strip dd {
  margin-top: 3px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.45;
}

.label-dimension-strip small {
  display: block;
  margin-top: 5px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.4;
}

.label-guide-sheet {
  display: grid;
  gap: 42px;
  margin-top: 40px;
}

.label-guide-section {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  gap: 26px;
  padding-top: 28px;
  border-top: 1px solid var(--color-border);
}

.label-guide-section > header {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  align-content: start;
  gap: 9px;
}

.label-guide-section > header > span {
  color: var(--about-gold);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: .06em;
}

.label-guide-section h3 {
  margin: 0;
  color: var(--color-ink);
  font-size: 15px;
  font-weight: 650;
}

.label-guide-section header p {
  margin-top: 5px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.45;
}

.label-definition-list {
  display: grid;
  margin: 0;
}

.label-definition-row {
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  padding: 13px 0;
}

.label-definition-row + .label-definition-row { border-top: 1px solid var(--color-border); }
.label-definition-row dt,
.label-definition-row dd { margin: 0; }

.label-token {
  width: max-content;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 5px 8px;
  color: var(--color-ink);
  background: var(--color-surface-subtle);
  font-size: 12px;
  font-weight: 680;
  line-height: 1;
  white-space: nowrap;
}

.label-token::before {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentColor;
  content: '';
  opacity: .8;
}

.profile-token[data-kind="taste"] { color: var(--color-danger); background: var(--color-danger-soft); }
.profile-token[data-kind="personality"] { color: var(--color-accent); background: var(--color-accent-soft); }
.profile-token[data-kind="judgment"] { color: var(--color-warning); background: var(--color-warning-soft); }
.origin-token { color: var(--color-ink); }
.status-token[data-status="pending"] { color: var(--color-warning); background: var(--color-warning-soft); }
.status-token[data-status="agent-confirmed"],
.status-token[data-status="confirmed"] { color: var(--color-success); background: var(--color-success-soft); }

.label-definition-row strong {
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 650;
}

.label-definition-row p {
  margin-top: 5px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.6;
}

.quadrant-explainer {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  grid-template-rows: auto 28px auto;
}

.quadrant-y-axis {
  grid-row: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 3px 0;
  color: var(--color-muted);
  font-size: 12px;
}

.quadrant-y-axis strong {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: .08em;
  text-orientation: upright;
  writing-mode: vertical-rl;
}

.quadrant-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
}

.quadrant-grid article {
  min-height: 108px;
  padding: 13px 15px;
  background: transparent;
}

.quadrant-grid article:nth-child(2n) { border-left: 1px solid var(--color-border); }
.quadrant-grid article:nth-child(n + 3) { border-top: 1px solid var(--color-border); }

.quadrant-grid span {
  color: var(--color-muted);
  font-size: 12px;
}

.quadrant-grid strong {
  display: block;
  margin-top: 6px;
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 650;
}

.quadrant-grid p {
  max-width: 340px;
  margin-top: 5px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.5;
}

.quadrant-x-axis {
  grid-column: 2;
  grid-row: 2;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 10px;
  color: var(--color-muted);
  font-size: 12px;
}

.quadrant-x-axis span:last-child { text-align: right; }
.quadrant-x-axis strong { color: var(--color-muted); font-size: 12px; font-weight: 650; letter-spacing: .08em; }

.quadrant-notes {
  grid-column: 2;
  grid-row: 3;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  padding-top: 8px;
}

.quadrant-notes p,
.status-boundaries p {
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.5;
}

.status-table-wrap { min-width: 0; }
.status-definition-table { width: 100%; border-collapse: collapse; }
.status-definition-table th,
.status-definition-table td {
  padding: 13px 12px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.55;
  text-align: left;
  vertical-align: top;
}

.status-definition-table thead th {
  padding-top: 0;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 650;
}

.status-definition-table tbody th { padding-left: 0; }
.status-definition-table tbody td:last-child { padding-right: 0; }
.status-definition-table td strong { color: var(--color-ink); font-size: 12px; font-weight: 620; }
.status-boundaries { display: flex; flex-wrap: wrap; gap: 6px 20px; padding-top: 12px; }

.label-example {
  display: grid;
  grid-template-columns: minmax(180px, .8fr) auto minmax(200px, 1fr);
  align-items: center;
  gap: 18px;
  padding: 20px 0 0;
  border-top: 1px solid var(--color-border);
}

.label-example > div:first-child { display: grid; gap: 4px; }
.label-example > div:first-child span { color: var(--color-muted); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
.label-example > div:first-child strong { color: var(--color-ink); font-size: 12px; font-weight: 620; }
.label-example-tags { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
.label-example > p { color: var(--color-muted); font-size: 12px; line-height: 1.5; }
.label-all-note { margin: 0; color: var(--color-muted); font-size: 12px; line-height: 1.5; }

@media (max-width: 720px) {
  .label-dimension-strip { grid-template-columns: 1fr; }
  .label-dimension-strip article + article { border-top: 1px solid var(--color-border); border-left: 0; }
  .label-guide-sheet { gap: 34px; margin-top: 32px; }
  .label-guide-section { grid-template-columns: 1fr; gap: 16px; }
  .status-definition-table thead { display: none; }
  .status-definition-table,
  .status-definition-table tbody,
  .status-definition-table tr,
  .status-definition-table th,
  .status-definition-table td { display: block; }
  .status-definition-table tbody tr { padding: 15px 0; }
  .status-definition-table tbody tr + tr { border-top: 1px solid var(--color-border); }
  .status-definition-table tbody th,
  .status-definition-table tbody td { padding: 0; border: 0; }
  .status-definition-table tbody td { margin-top: 9px; }
  .status-definition-table tbody td::before { display: block; margin-bottom: 2px; color: var(--color-muted); content: attr(data-label); font-size: 12px; font-weight: 650; }
  .label-example { grid-template-columns: 1fr; gap: 12px; }
  .label-example-tags { justify-content: flex-start; }
}
</style>
