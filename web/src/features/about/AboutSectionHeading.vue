<script setup lang="ts">
defineProps<{ titleId: string; title: string; description: string }>()
</script>

<template>
  <header class="about-section-heading">
    <h2 :id="titleId">{{ title }}</h2>
    <p>{{ description }}</p>
  </header>
</template>

<style scoped>
.about-section-heading {
  padding-bottom: 24px;
  border-bottom: 1px solid var(--color-border);
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
  max-width: 680px;
  margin-top: 8px;
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.65;
}
</style>
