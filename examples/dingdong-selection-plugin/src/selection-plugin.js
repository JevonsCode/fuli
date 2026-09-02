export function createSelectionPlugin() {
  let active = false;
  return {
    async activate() {
      active = true;
    },
    async deactivate() {
      active = false;
    },
    commands: {
      async copy({ input, host }) {
        requireActive(active);
        const text = host.readSelection(input.selection);
        await host.writeClipboard(text);
        return { action: 'copy', text, copied: true };
      },
      async translate({ input, host, signal }) {
        requireActive(active);
        const text = host.readSelection(input.selection);
        const translated = await host.translate({
          text,
          targetLanguage: normalizeLocale(input.targetLanguage, 'zh-CN'),
          signal
        });
        return { action: 'translate', text, result: translated };
      },
      async explain({ input, host, signal }) {
        requireActive(active);
        const text = host.readSelection(input.selection);
        const explanation = await host.explain({
          text,
          locale: normalizeLocale(input.locale, 'zh-CN'),
          signal
        });
        return { action: 'explain', text, result: explanation };
      }
    }
  };
}

function normalizeLocale(value, fallback) {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const locale = value.trim();
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) return fallback;
  return locale;
}

function requireActive(active) {
  if (!active) {
    const error = new Error('Selection plugin is inactive');
    error.code = 'PLUGIN_INACTIVE';
    throw error;
  }
}
