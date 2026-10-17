import { computed, ref, watch, type Ref } from "vue";

/**
 * Keep a list in the order the reader first saw once its data settled.
 * Fresh data updates rows in place; new ids are appended in fresh order and
 * the caller decides when to apply the latest order again.
 */
export function useStableOrder(
  fresh: Ref<string[]>,
  settled: Ref<boolean>,
  resetKey: Ref<unknown>,
) {
  const applied = ref<string[]>([]);
  watch(resetKey, () => {
    applied.value = [];
  });
  watch(
    [fresh, settled],
    ([ids, ready]) => {
      if (ready && ids.length && !applied.value.length) applied.value = [...ids];
    },
    { immediate: true },
  );
  const order = computed(() => {
    if (!applied.value.length) return fresh.value;
    const rank = new Map(applied.value.map((id, index) => [id, index]));
    const known = fresh.value
      .filter((id) => rank.has(id))
      .sort((a, b) => rank.get(a)! - rank.get(b)!);
    return [...known, ...fresh.value.filter((id) => !rank.has(id))];
  });
  function apply() {
    applied.value = [...fresh.value];
  }
  return { order, apply };
}
