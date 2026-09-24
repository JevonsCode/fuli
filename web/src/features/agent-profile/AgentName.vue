<script setup lang="ts">
import { RouterLink } from "vue-router";
import { agentProfilePath } from "./profile-model";
defineProps<{ spaceId: string; agentId: string; name: string }>();
</script>
<template>
  <RouterLink
    class="agent-name-link"
    :to="agentProfilePath(spaceId, agentId)"
    >{{ name }}</RouterLink
  >
</template>
<style scoped>
.agent-name-link {
  color: inherit;
  font-weight: 650;
  text-decoration: underline;
  text-decoration-color: #b5c9bd;
  text-underline-offset: 4px;
  overflow-wrap: anywhere;
}
.agent-name-link:hover {
  color: #24533c;
  text-decoration-color: currentColor;
}
.agent-name-link:focus-visible {
  outline: 2px solid #315c43;
  outline-offset: 4px;
  border-radius: 2px;
}
</style>
