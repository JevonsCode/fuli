<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { t } from '@/i18n'

// Marks an entry still in testing (runners, the LAN roundtable), not the
// release it ships in: a stable FULI can carry Beta features. The same small
// chip everywhere, in the design system's primary tint; the word is "Beta" in
// both languages and its hint says what that means.
</script>

<template>
  <Badge class="beta-badge" variant="default" :title="t('common.beta.hint')" data-beta-badge>
    {{ t('common.beta.label') }}
  </Badge>
</template>

<style scoped>
.beta-badge {
  flex: none;
  margin-inline: 6px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .02em;
  line-height: 18px;
  vertical-align: middle;
  user-select: none;
}
</style>
