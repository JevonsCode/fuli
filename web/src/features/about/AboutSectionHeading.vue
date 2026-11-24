<script setup lang="ts">
defineProps<{ titleId: string; title: string; description: string }>()
</script>

<template>
  <header class="about-section-heading">
    <div class="about-section-heading__row">
      <h2 :id="titleId">{{ title }}</h2>
      <slot name="action" />
    </div>
    <p class="ui-prose">{{ description }}</p>
  </header>
</template>

<style scoped>
.about-section-heading {
  padding-bottom: 24px;
  border-bottom: 1px solid var(--color-border);
}

/* The title with an optional action on its right; the action wraps below on a narrow page. */
.about-section-heading__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
}

.about-section-heading h2 {
  margin: 0;
  color: var(--color-ink);
  font-size: clamp(20px, 2.6vw, 26px);
  font-weight: 650;
  letter-spacing: -.02em;
  line-height: 1.25;
}

.about-section-heading p {
  margin-top: 8px;
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.65;
}
</style>
