<script setup lang="ts">
import { computed } from 'vue'

import PageStack from '@/components/PageStack.vue'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { OptionSelect } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import CliPathSettings from '@/features/cli-path/CliPathSettings.vue'
import { CONVERSATION_SOURCE_APPLICATIONS, sourceApplicationName } from '@/features/knowledge/source-adapters'
import NpmCopiesSettings from '@/features/npm-copies/NpmCopiesSettings.vue'
import { t } from '@/i18n'
import type { ConversationSourceApplication, RuntimeSettings } from '@/types'
import ClientConnectionSettings from './ClientConnectionSettings.vue'
import ClientLinksSettings from './ClientLinksSettings.vue'
import ClientManualConnection from './ClientManualConnection.vue'
import { provideClientConnectionStatus } from './client-connection-status'
import { fieldErrorId } from './settings-field-error'

// Settings › 客户端: whether each client has FULI comes first, then how a
// session opens and where FULI calls the person. Connecting by hand, npm
// copies, /fla, the terminal command and the session links follow below as
// open cards of their own, so none of them folds or pushes a neighbour.
const form = defineModel<RuntimeSettings>('form', { required: true })
const props = defineProps<{ fieldErrors: Readonly<Record<string, string>> }>()

provideClientConnectionStatus()
const conversationApplications = CONVERSATION_SOURCE_APPLICATIONS
// Two stacks side by side, each its own height: a client whose fields are open pushes down only
// the clients under it, and nothing is left empty beside it.
const launcherHalf = Math.ceil(conversationApplications.length / 2)
const launcherColumns = [conversationApplications.slice(0, launcherHalf), conversationApplications.slice(launcherHalf)]
const conversationIdFormatOptions = computed(() => [
  { value: 'any', label: t('settings.conversationLaunchers.idFormats.any') },
  { value: 'uuid', label: t('settings.conversationLaunchers.idFormats.uuid') },
])
const errorFor = (key: string) => props.fieldErrors[key] ?? ''

function conversationApplicationLabel(application: ConversationSourceApplication) {
  const translated = t(`settings.conversationLaunchers.applications.${application}`)
  return translated === `settings.conversationLaunchers.applications.${application}`
    ? sourceApplicationName(application)
    : translated
}
</script>

<template>
  <div class="clients-tab">
    <PageStack>
      <ClientConnectionSettings />
      <Card as="section" id="conversation-launchers" class="settings-card conversation-launcher-card" aria-labelledby="settings-launchers-title">
        <CardHeader><CardTitle id="settings-launchers-title" as="h2">{{ t('settings.conversationLaunchers.title') }}<AiHelpButton term="task.launchers" /></CardTitle>
          <CardDescription>{{ t('settings.conversationLaunchers.description') }}</CardDescription></CardHeader>
        <div class="conversation-launcher-columns">
        <div v-for="(column, side) in launcherColumns" :key="side" class="setting-list conversation-launcher-list">
          <article v-for="application in column" :key="application" class="conversation-launcher-row">
            <div class="conversation-launcher-heading">
              <span>
                <strong>{{ conversationApplicationLabel(application) }}</strong>
                <small>{{ t('settings.conversationLaunchers.sourceId', { id: application }) }}</small>
              </span>
              <label class="conversation-launcher-switch">
                <span>{{ t('settings.conversationLaunchers.enabled') }}</span>
                <Switch v-model="form.conversationLaunchers[application].enabled" :aria-label="t('settings.conversationLaunchers.enabled')" />
              </label>
            </div>
            <small v-if="form.conversationLaunchers[application].enabled && application === 'codex'" class="conversation-launcher-note">
              {{ t('settings.conversationLaunchers.idFormatMeta') }}
            </small>
            <div v-if="form.conversationLaunchers[application].enabled" class="conversation-launcher-fields">
              <label>
                <span>{{ t('settings.conversationLaunchers.idFormat') }}</span>
                <OptionSelect
                  v-model="form.conversationLaunchers[application].idFormat"
                  class="launcher-select"
                  :control-id="`settings-conversation-${application}-id-format`"
                  :options="conversationIdFormatOptions"
                  :label="t('settings.conversationLaunchers.idFormat')"
                />
              </label>
              <label>
                <span>{{ t('settings.conversationLaunchers.appName') }}</span>
                <input v-model.trim="form.conversationLaunchers[application].appName" type="text" maxlength="64" required
                  :data-settings-field="`launchers.${application}.appName`"
                  :aria-invalid="errorFor(`launchers.${application}.appName`) ? 'true' : undefined"
                  :aria-describedby="errorFor(`launchers.${application}.appName`) ? fieldErrorId(`launchers.${application}.appName`) : undefined" />
                <small v-if="errorFor(`launchers.${application}.appName`)" :id="fieldErrorId(`launchers.${application}.appName`)" class="settings-field-error" data-settings-field-error>{{ errorFor(`launchers.${application}.appName`) }}</small>
              </label>
              <label class="conversation-launcher-template">
                <span>
                  {{ t('settings.conversationLaunchers.urlTemplate') }}
                  <small><code>{id}</code></small>
                </span>
                <input v-model.trim="form.conversationLaunchers[application].urlTemplate" type="text" maxlength="1024" spellcheck="false" required
                  :data-settings-field="`launchers.${application}.urlTemplate`"
                  :aria-invalid="errorFor(`launchers.${application}.urlTemplate`) ? 'true' : undefined"
                  :aria-describedby="errorFor(`launchers.${application}.urlTemplate`) ? fieldErrorId(`launchers.${application}.urlTemplate`) : undefined" />
                <small v-if="errorFor(`launchers.${application}.urlTemplate`)" :id="fieldErrorId(`launchers.${application}.urlTemplate`)" class="settings-field-error" data-settings-field-error>{{ errorFor(`launchers.${application}.urlTemplate`) }}</small>
              </label>
            </div>
          </article>
        </div>
        </div>
      </Card>
      <Card v-if="form.notifications" as="section" id="notifications" class="settings-card notifications-card" aria-labelledby="settings-notifications-title">
        <CardHeader><CardTitle id="settings-notifications-title" as="h2">{{ t('settings.notifications.title') }}<AiHelpButton term="task.notifications" /></CardTitle></CardHeader>
        <div class="setting-list">
          <label class="notification-url">
            <span>
              <strong class="notification-url__head">{{ t('settings.notifications.needsPersonUrl') }}
                <a class="notification-url__link" href="https://xn--8ovp9s.xn--m8txu.com/DingDongBuddy/" target="_blank" rel="noopener noreferrer" data-dingdong-link>{{ t('settings.notifications.dingdong') }}</a>
              </strong>
              <small>{{ t('settings.notifications.needsPersonUrlMeta') }}</small>
            </span>
            <input v-model.trim="form.notifications.needsPersonUrl" type="url" maxlength="2048" spellcheck="false"
              placeholder="http://127.0.0.1:9123/fuli" data-needs-person-url data-settings-field="notifications.needsPersonUrl"
              :aria-invalid="errorFor('notifications.needsPersonUrl') ? 'true' : undefined"
              :aria-describedby="errorFor('notifications.needsPersonUrl') ? fieldErrorId('notifications.needsPersonUrl') : undefined" />
            <small v-if="errorFor('notifications.needsPersonUrl')" :id="fieldErrorId('notifications.needsPersonUrl')" class="settings-field-error" data-settings-field-error>{{ errorFor('notifications.needsPersonUrl') }}</small>
          </label>
        </div>
      </Card>
    </PageStack>

    <!-- Less used: connecting by hand and the other ways in. Open cards, below. -->
    <section class="clients-more" aria-labelledby="settings-clients-more" data-clients-more>
      <h2 id="settings-clients-more" class="ui-group-label">{{ t('settings.clientsMore') }}</h2>
      <PageStack>
        <ClientManualConnection />
        <NpmCopiesSettings />
        <Card v-if="form.flaSlashMenu !== undefined" as="section" class="settings-card" aria-labelledby="settings-fla-slash-menu-title" data-fla-slash-menu-card>
          <div class="setting-list">
            <label class="setting-row">
              <span><strong id="settings-fla-slash-menu-title">{{ t('settings.flaSlashMenu.title') }}</strong><small>{{ t('settings.flaSlashMenu.description') }}</small></span>
              <Switch v-model="form.flaSlashMenu" :aria-label="t('settings.flaSlashMenu.title')" data-settings-field="flaSlashMenu" />
            </label>
          </div>
        </Card>
        <ClientLinksSettings />
        <CliPathSettings />
      </PageStack>
    </section>
  </div>
</template>

<style scoped>
.clients-tab { display: grid; gap: var(--space-8); min-width: 0; }
.clients-more { display: grid; gap: var(--space-3); min-width: 0; }
.clients-more > h2 { margin: 0; }

/* Full width, its clients in two stacks: a tall list beside the short 通知 card left half the row
   empty, and rows paired across would leave a gap beside a client whose fields are open. */
.conversation-launcher-columns { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0 var(--space-8, 32px); }
.conversation-launcher-list { display: grid; flex: 1 1 440px; min-width: 0; }
.conversation-launcher-row { padding: 16px 0; border-bottom: 1px solid var(--color-border); }
.conversation-launcher-heading { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.conversation-launcher-heading > span { display: grid; min-width: 0; gap: 4px; overflow-wrap: anywhere; }
.conversation-launcher-heading strong { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.conversation-launcher-heading small { color: var(--color-muted); font-size: 12px; }
.conversation-launcher-switch { display: flex; flex: 0 0 auto; align-items: center; gap: 9px; color: var(--color-muted); font-size: 12px; }
.conversation-launcher-note { display: block; max-width: 760px; margin-top: 9px; color: var(--color-muted); font-size: 12px; line-height: 1.45; }
.conversation-launcher-fields {
  display: grid; align-items: start; grid-template-columns: minmax(0, .7fr) minmax(0, .8fr) minmax(0, 1.5fr); gap: 12px; margin-top: 14px;
}
.conversation-launcher-fields > label {
  min-width: 0; display: grid; grid-template-rows: auto var(--control-height-md); align-content: start; gap: 7px; color: var(--color-muted); font-size: 12px;
}
.conversation-launcher-fields > label > span { min-width: 0; display: block; line-height: 18px; overflow-wrap: anywhere; }
.conversation-launcher-fields code { color: var(--color-muted); font-size: 12px; }
.conversation-launcher-fields :deep(.launcher-select) { width: 100%; min-width: 0; }
.conversation-launcher-fields input { width: 100%; min-width: 0; }
.notification-url { display: grid; gap: 10px; }
.notification-url > span { display: grid; gap: 4px; }
.notification-url strong { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.notification-url small { color: var(--color-muted); font-size: 12px; }
.notification-url__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.notification-url__link { font-size: 12px; font-weight: var(--weight-regular, 400); user-select: none; }
.notification-url input { width: 100%; min-width: 0; }

@container (max-width: 640px) {
  .conversation-launcher-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .conversation-launcher-template { grid-column: 1 / -1; }
}

@container (max-width: 420px) {
  .conversation-launcher-fields { grid-template-columns: minmax(0, 1fr); }
  .conversation-launcher-template { grid-column: auto; }
}
</style>
