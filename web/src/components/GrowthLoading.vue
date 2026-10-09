<script setup lang="ts">
const props = withDefaults(defineProps<{
  label: string
  variant?: 'page' | 'compact' | 'inline'
}>(), { variant: 'page' })
</script>

<template>
  <span
    class="growth-loading"
    :class="[`growth-loading--${props.variant}`, { 'view-loading': props.variant === 'page' }]"
    role="status"
    aria-live="polite"
    aria-atomic="true"
    :aria-label="props.label"
  >
    <span class="growth-loading__content">
      <span class="growth-loading__visual" aria-hidden="true">
        <svg
          class="growth-loading__mark"
          viewBox="0 0 48 48"
          aria-hidden="true"
          focusable="false"
        >
          <path class="growth-loading__arc growth-loading__arc--1" d="M24 5 A19 19 0 0 1 40.45 33.5" />
          <path class="growth-loading__arc growth-loading__arc--2" d="M40.45 33.5 A19 19 0 0 1 7.55 33.5" />
          <path class="growth-loading__arc growth-loading__arc--3" d="M7.55 33.5 A19 19 0 0 1 24 5" />
        </svg>
      </span>
      <span class="growth-loading__label">{{ props.label }}</span>
    </span>
  </span>
</template>

<style scoped>
.growth-loading {
  --growth-loading-size: 48px;
  display: block;
  min-width: 0;
  color: var(--color-muted, #667085);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
}

.growth-loading--compact {
  --growth-loading-size: 28px;
  display: grid;
  place-items: center;
  min-height: 104px;
  padding: 16px;
}

.growth-loading--inline {
  --growth-loading-size: 16px;
  display: inline-flex;
  max-width: 100%;
  vertical-align: middle;
}

.growth-loading__content {
  display: grid;
  justify-items: center;
  min-width: 0;
  gap: 8px;
}

.growth-loading--inline .growth-loading__content {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.growth-loading__visual {
  display: block;
  width: var(--growth-loading-size);
  height: var(--growth-loading-size);
  flex: 0 0 auto;
}

.growth-loading__mark {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.growth-loading__arc {
  --growth-loading-delay: 0s;
  --growth-loading-start: 0deg;
  --growth-loading-end: 0deg;
  fill: none;
  stroke: var(--color-accent, #2563EB);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 3.25;
  opacity: .32;
  transform: rotate(var(--growth-loading-start));
  transform-box: view-box;
  transform-origin: center;
  animation: growth-loading-arc 2.4s cubic-bezier(.45, 0, .22, 1) var(--growth-loading-delay) infinite;
  will-change: transform, opacity;
}

.growth-loading__arc--1 {
  --growth-loading-start: -12deg;
  --growth-loading-end: -18deg;
  --growth-loading-delay: 0s;
}

.growth-loading__arc--2 {
  --growth-loading-start: 10deg;
  --growth-loading-end: 18deg;
  --growth-loading-delay: .12s;
}

.growth-loading__arc--3 {
  --growth-loading-start: -8deg;
  --growth-loading-end: 24deg;
  --growth-loading-delay: .24s;
}

.growth-loading__label {
  color: var(--color-muted, #667085);
  font-size: 14px;
  line-height: 1.4;
  text-align: center;
  overflow-wrap: anywhere;
}

.growth-loading--inline .growth-loading__label {
  text-align: left;
}

@keyframes growth-loading-arc {
  0%, 10% {
    opacity: .32;
    transform: rotate(var(--growth-loading-start));
  }

  38%, 60% {
    opacity: 1;
    transform: rotate(0deg);
  }

  84%, 100% {
    opacity: .24;
    transform: rotate(var(--growth-loading-end));
  }
}

@media (prefers-reduced-motion: reduce) {
  .growth-loading__arc {
    opacity: 1;
    transform: none;
    animation: none;
    will-change: auto;
  }
}
</style>
