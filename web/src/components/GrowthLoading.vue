<script setup lang="ts">
defineProps<{
  label: string
}>()
</script>

<template>
  <div
    class="view-loading growth-loading"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <div class="growth-loading__content">
      <div class="growth-loading__chart" aria-hidden="true">
        <span class="growth-loading__bar growth-loading__bar--1"><i /></span>
        <span class="growth-loading__bar growth-loading__bar--2"><i /></span>
        <span class="growth-loading__bar growth-loading__bar--3"><i /></span>
        <span class="growth-loading__bar growth-loading__bar--4"><i /></span>
        <span class="growth-loading__bar growth-loading__bar--5"><i /></span>
        <span class="growth-loading__baseline" />
      </div>
      <span class="growth-loading__label">{{ label }}</span>
    </div>
  </div>
</template>

<style scoped>
.growth-loading__content {
  display: grid;
  justify-items: center;
}

.growth-loading__chart {
  position: relative;
  width: 126px;
  height: 70px;
  display: flex;
  align-items: end;
  justify-content: center;
  gap: 7px;
  padding: 0 8px 7px;
  contain: layout paint;
}

.growth-loading__bar {
  --rest: 20%;
  --peak: 76%;
  --delay: 0s;
  --tide-delay: 0s;
  position: relative;
  z-index: 1;
  width: 15px;
  flex: 0 0 15px;
  overflow: hidden;
  border: 1px solid rgba(70, 100, 82, .15);
  border-radius: 5px 5px 3px 3px;
  background: rgba(255, 255, 255, .48);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .72);
}

.growth-loading__bar i {
  position: absolute;
  right: 1px;
  bottom: 1px;
  left: 1px;
  height: var(--rest);
  border-radius: 2px 2px 1px 1px;
  background: linear-gradient(180deg, #8fae9c 0%, #5f836f 100%);
  box-shadow: 0 -1px 4px rgba(70, 109, 87, .12);
  animation: growth-loading-rise 3.2s cubic-bezier(.45, 0, .22, 1) var(--delay) infinite;
  will-change: height;
}

.growth-loading__bar i::before {
  content: '';
  position: absolute;
  top: -3px;
  left: -38%;
  width: 176%;
  height: 7px;
  border-radius: 50%;
  background: #a5beaf;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .35);
  animation: growth-loading-tide 1.35s ease-in-out var(--tide-delay) infinite alternate;
}

.growth-loading__bar--1 {
  --rest: 28%;
  --peak: 62%;
  height: 26px;
}

.growth-loading__bar--2 {
  --rest: 22%;
  --peak: 70%;
  --delay: .12s;
  --tide-delay: -.12s;
  height: 35px;
}

.growth-loading__bar--3 {
  --rest: 25%;
  --peak: 78%;
  --delay: .24s;
  --tide-delay: -.24s;
  height: 44px;
}

.growth-loading__bar--4 {
  --rest: 20%;
  --peak: 86%;
  --delay: .36s;
  --tide-delay: -.36s;
  height: 53px;
}

.growth-loading__bar--5 {
  --rest: 24%;
  --peak: 94%;
  --delay: .48s;
  --tide-delay: -.48s;
  height: 62px;
}

.growth-loading__baseline {
  position: absolute;
  right: 4px;
  bottom: 6px;
  left: 4px;
  height: 1px;
  overflow: hidden;
  background: linear-gradient(90deg, transparent, rgba(72, 103, 85, .22) 18%, rgba(72, 103, 85, .22) 82%, transparent);
}

.growth-loading__baseline::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -32%;
  width: 32%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .92), transparent);
  animation: growth-loading-reflection 3.2s ease-in-out infinite;
}

.growth-loading__label {
  margin-top: 11px;
  color: #778079;
  font-size: 12px;
  line-height: 1.5;
}

@keyframes growth-loading-rise {
  0%, 12% {
    height: var(--rest);
  }

  50%, 68% {
    height: var(--peak);
  }

  100% {
    height: var(--rest);
  }
}

@keyframes growth-loading-tide {
  from {
    transform: translateX(-5%) rotate(-1deg);
  }

  to {
    transform: translateX(5%) rotate(1deg);
  }
}

@keyframes growth-loading-reflection {
  0%, 18% {
    transform: translateX(0);
    opacity: 0;
  }

  38%, 68% {
    opacity: .72;
  }

  86%, 100% {
    transform: translateX(420%);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .growth-loading__bar i {
    height: var(--peak);
    animation: none;
  }

  .growth-loading__bar i::before,
  .growth-loading__baseline::after {
    animation: none;
  }
}
</style>
