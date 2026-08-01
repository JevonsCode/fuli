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
          <div>
            <strong>{{ dimension.title }}</strong>
            <p>{{ dimension.question }}</p>
            <small>{{ dimension.timing }}</small>
          </div>
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
          <div class="label-definition-list">
            <article v-for="profile in profiles" :key="profile.key" class="label-definition-row">
              <span class="label-token profile-token" :data-kind="profile.key">{{ profile.label }}</span>
              <div>
                <strong>{{ profile.short }}</strong>
                <p>{{ profile.description }}</p>
              </div>
            </article>
          </div>
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
            <div class="quadrant-grid">
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
          <div>
            <div class="status-definition-list">
              <article v-for="status in statuses" :key="status.key" class="status-definition-row">
                <span class="label-token status-token" :data-status="status.key">{{ status.label }}</span>
                <p>{{ status.description }}</p>
                <div>
                  <span>{{ t('about.statuses.entryCondition') }}</span>
                  <strong>{{ status.rule }}</strong>
                </div>
              </article>
            </div>
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
  border: 1px solid #d4dad5;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}

.label-dimension-strip article {
  min-width: 0;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 11px;
  padding: 15px 17px;
}

.label-dimension-strip article + article {
  border-left: 1px solid #e1e5e1;
}

.label-dimension-strip i {
  position: relative;
  width: 27px;
  height: 27px;
  border: 1px solid #cdd7d0;
  border-radius: 7px;
  background: #f2f6f3;
}

.label-dimension-strip i::before,
.label-dimension-strip i::after {
  position: absolute;
  content: '';
}

.label-dimension-strip [data-dimension="profile"] i::before {
  inset: 6px;
  border: 1.5px solid #537461;
  border-radius: 50%;
}

.label-dimension-strip [data-dimension="profile"] i::after {
  top: 4px;
  right: 4px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #8f6b59;
}

.label-dimension-strip [data-dimension="origin"] i::before {
  inset: 5px;
  border-right: 1px solid #597266;
  border-bottom: 1px solid #597266;
}

.label-dimension-strip [data-dimension="origin"] i::after {
  top: 5px;
  right: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #735f79;
}

.label-dimension-strip [data-dimension="confirmation"] i::before {
  top: 6px;
  left: 6px;
  width: 13px;
  height: 7px;
  border-left: 2px solid #537461;
  border-bottom: 2px solid #537461;
  transform: rotate(-45deg);
}

.label-dimension-strip strong,
.label-dimension-strip p,
.label-dimension-strip small {
  display: block;
}

.label-dimension-strip strong {
  color: #33443a;
  font-size: 12px;
}

.label-dimension-strip p {
  margin-top: 2px;
  color: #68736c;
  font-size: 10px;
}

.label-dimension-strip small {
  margin-top: 5px;
  color: #929a94;
  font-size: 8px;
  line-height: 1.35;
}

.label-guide-sheet {
  margin-top: 14px;
  border: 1px solid #d4dad5;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}

.label-guide-section {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 24px;
  padding: 24px;
}

.label-guide-section + .label-guide-section {
  border-top: 1px solid #e0e4e0;
}

.label-guide-section > header {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  align-content: start;
  gap: 9px;
}

.label-guide-section > header > span {
  color: #a0a7a2;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
}

.label-guide-section h3 {
  color: #2e3c34;
  font-size: 15px;
}

.label-guide-section header p {
  margin-top: 4px;
  color: #879089;
  font-size: 9px;
}

.label-definition-list,
.status-definition-list {
  display: grid;
}

.label-definition-row {
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  padding: 12px 0;
}

.label-definition-row + .label-definition-row,
.status-definition-row + .status-definition-row {
  border-top: 1px solid #edf0ed;
}

.label-token {
  width: max-content;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 5px 9px;
  font-size: 9px;
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
  opacity: .72;
}

.profile-token[data-kind="taste"] {
  color: #7a574b;
  background: #f5eeeb;
}

.profile-token[data-kind="personality"] {
  color: #4f6970;
  background: #edf3f4;
}

.profile-token[data-kind="judgment"] {
  color: #665b7a;
  background: #f1eef6;
}

.label-definition-row strong {
  color: #3f4b44;
  font-size: 11px;
}

.label-definition-row p {
  margin-top: 4px;
  color: #6f7972;
  font-size: 10px;
  line-height: 1.55;
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
  color: #8a938d;
  font-size: 8px;
}

.quadrant-y-axis strong {
  color: #68736c;
  font-size: 8px;
  font-weight: 650;
  letter-spacing: .08em;
  text-orientation: upright;
  writing-mode: vertical-rl;
}

.quadrant-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 1px solid #cfd7d1;
  border-radius: 7px;
  overflow: hidden;
}

.quadrant-grid article {
  min-height: 118px;
  padding: 14px 16px;
}

.quadrant-grid article:nth-child(2n) {
  border-left: 1px solid #dce2dd;
}

.quadrant-grid article:nth-child(n + 3) {
  border-top: 1px solid #dce2dd;
}

.quadrant-grid article[data-quadrant="known-unknown"] { background: #f6f2e8; }
.quadrant-grid article[data-quadrant="known-known"] { background: #edf5f0; }
.quadrant-grid article[data-quadrant="unknown-unknown"] { background: #f4eff4; }
.quadrant-grid article[data-quadrant="unknown-known"] { background: #edf4f5; }

.quadrant-grid span {
  color: #838d86;
  font-size: 8px;
}

.quadrant-grid strong {
  display: block;
  margin-top: 7px;
  color: #35443b;
  font-size: 13px;
}

.quadrant-grid p {
  max-width: 340px;
  margin-top: 6px;
  color: #68736c;
  font-size: 10px;
  line-height: 1.5;
}

.quadrant-x-axis {
  grid-column: 2;
  grid-row: 2;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 10px;
  color: #8a938d;
  font-size: 8px;
}

.quadrant-x-axis span:last-child { text-align: right; }

.quadrant-x-axis strong {
  color: #68736c;
  font-size: 8px;
  letter-spacing: .08em;
}

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
  color: #77817a;
  font-size: 9px;
  line-height: 1.45;
}

.status-definition-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) minmax(180px, .72fr);
  align-items: start;
  gap: 16px;
  padding: 12px 0;
}

.status-token[data-status="pending"] {
  color: #77602f;
  background: #f7f2e5;
}

.status-token[data-status="agent-confirmed"] {
  color: #4d5f78;
  background: #eef2f7;
}

.status-token[data-status="confirmed"] {
  color: #356047;
  background: #edf6f0;
}

.status-definition-row > p {
  color: #67726b;
  font-size: 10px;
  line-height: 1.55;
}

.status-definition-row > div {
  display: grid;
  gap: 3px;
}

.status-definition-row > div span {
  color: #929a94;
  font-size: 8px;
}

.status-definition-row > div strong {
  color: #4b5750;
  font-size: 9px;
  font-weight: 620;
  line-height: 1.45;
}

.status-boundaries {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  margin-top: 8px;
  padding-top: 10px;
  border-top: 1px solid #edf0ed;
}

.label-example {
  display: grid;
  grid-template-columns: minmax(220px, .8fr) auto minmax(260px, 1fr);
  align-items: center;
  gap: 22px;
  padding: 18px 24px;
  border-top: 1px solid #dce2dd;
  background: #f7f9f7;
}

.label-example > div:first-child {
  display: grid;
  gap: 4px;
}

.label-example > div:first-child span {
  color: #89928c;
  font-size: 8px;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.label-example > div:first-child strong {
  color: #34433a;
  font-size: 11px;
}

.label-example-tags {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}

.origin-token {
  color: #3f6b55;
  background: #eaf3ed;
}

.label-example > p {
  color: #68736c;
  font-size: 9px;
  line-height: 1.5;
}

.label-all-note {
  padding: 12px 24px;
  border-top: 1px solid #e3e7e3;
  color: #7b847e;
  font-size: 9px;
  text-align: center;
}

@media (max-width: 1180px) {
  .label-guide-section {
    grid-template-columns: 1fr;
    gap: 16px;
  }

  .label-example {
    grid-template-columns: minmax(210px, .8fr) minmax(0, 1.2fr);
  }

  .label-example-tags {
    justify-content: flex-end;
  }

  .label-example > p {
    grid-column: 1 / -1;
  }
}
</style>
