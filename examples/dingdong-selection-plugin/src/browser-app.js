import manifest from '../plugin.json' with { type: 'json' };
import { createPluginRuntime } from './plugin-runtime.js';
import { createSelectionPlugin } from './selection-plugin.js';
import { createHttpTextService } from './text-service.js';

const readingSurface = document.querySelector('[data-reading-surface]');
const toolbar = document.querySelector('[data-selection-toolbar]');
const preview = document.querySelector('[data-selection-preview]');
const result = document.querySelector('[data-result]');
const resultTitle = document.querySelector('[data-result-title]');
const resultBody = document.querySelector('[data-result-body]');
const status = document.querySelector('[data-status]');
const endpoint = document.querySelector('[data-endpoint]');
const targetLanguage = document.querySelector('[data-language]');
const configureButton = document.querySelector('[data-configure]');
const configPanel = document.querySelector('[data-config-panel]');
const textServiceState = document.querySelector('[data-text-service-state]');

let selectedText = '';
let busy = false;

const textService = {
  translate: (payload) => createHttpTextService({ endpoint: endpoint.value }).translate(payload),
  explain: (payload) => createHttpTextService({ endpoint: endpoint.value }).explain(payload)
};

const runtime = createPluginRuntime({
  ports: {
    clipboard: { writeText: (text) => navigator.clipboard.writeText(text) },
    textService
  },
  onEvent(event) {
    document.documentElement.dataset.pluginState = event.type;
  }
});

runtime.register(manifest, createSelectionPlugin);
await runtime.start(manifest.id);

readingSurface.addEventListener('pointerup', captureSelection);
readingSurface.addEventListener('keydown', handleKeyboardSelection);
readingSurface.addEventListener('keyup', captureSelection);
document.addEventListener('selectionchange', scheduleSelectionCapture);
document.addEventListener('pointerdown', (event) => {
  if (!toolbar.contains(event.target) && !readingSurface.contains(event.target)) {
    hideToolbar();
  }
});

toolbar.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-command]');
  if (!button || busy) return;
  await runCommand(button.dataset.command);
});

configureButton.addEventListener('click', () => {
  const expanded = configureButton.getAttribute('aria-expanded') === 'true';
  configureButton.setAttribute('aria-expanded', String(!expanded));
  configPanel.hidden = expanded;
  if (!expanded) endpoint.focus();
});
endpoint.addEventListener('input', updateTextServiceState);
updateTextServiceState();

window.addEventListener('pagehide', () => runtime.stop(manifest.id), { once: true });

function captureSelection() {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? '';
  if (!text || !selection.rangeCount) {
    hideToolbar();
    return;
  }
  const range = selection.getRangeAt(0);
  if (!readingSurface.contains(range.commonAncestorContainer)) {
    hideToolbar();
    return;
  }
  selectedText = text.slice(0, 10_000);
  preview.textContent = selectedText;
  positionToolbar(selectionRect(range));
  toolbar.hidden = false;
  status.textContent = `已选中 ${selectedText.length} 个字符`;
}

let selectionCaptureFrame = 0;

function scheduleSelectionCapture() {
  cancelAnimationFrame(selectionCaptureFrame);
  selectionCaptureFrame = requestAnimationFrame(captureSelection);
}

function handleKeyboardSelection(event) {
  if (!event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const selection = window.getSelection();
  if (!selection) return;
  event.preventDefault();

  if (!selection.rangeCount || !readingSurface.contains(selection.anchorNode)) {
    const textNode = edgeTextNode(event.key === 'ArrowLeft' ? 'end' : 'start');
    if (!textNode) return;
    const range = document.createRange();
    const offset = event.key === 'ArrowLeft'
      ? textNode.textContent.length
      : textNode.textContent.search(/\S/);
    range.setStart(textNode, Math.max(0, offset));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  if (typeof selection.modify === 'function') {
    selection.modify(
      'extend',
      event.key === 'ArrowLeft' ? 'backward' : 'forward',
      'character'
    );
  }
  scheduleSelectionCapture();
}

function edgeTextNode(edge) {
  const walker = document.createTreeWalker(
    readingSurface,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent.trim() || node.parentElement?.closest('.selection-hint')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  if (edge === 'start') return walker.nextNode();
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function selectionRect(range) {
  const rects = Array.from(range.getClientRects());
  return rects.at(-1) ?? range.getBoundingClientRect();
}

function positionToolbar(rect) {
  toolbar.style.setProperty('--selection-x', `${Math.max(16, rect.left + rect.width / 2)}px`);
  toolbar.style.setProperty('--selection-y', `${Math.max(16, rect.bottom + 12)}px`);
}

function updateTextServiceState() {
  const value = endpoint.value.trim();
  textServiceState.textContent = !value
    ? '未配置'
    : endpoint.validity.valid
      ? '已配置'
      : '地址无效';
}

async function runCommand(command) {
  setBusy(true, command);
  try {
    const response = await runtime.execute(manifest.id, command, {
      selection: selectedText,
      targetLanguage: targetLanguage.value,
      locale: document.documentElement.lang
    });
    if (command === 'copy') {
      status.textContent = '原文已复制到剪贴板。';
      result.hidden = true;
      hideToolbar();
      return;
    }
    resultTitle.textContent = command === 'translate' ? '翻译结果' : '解释结果';
    resultBody.textContent = response.result;
    result.hidden = false;
    status.textContent = `${resultTitle.textContent}已返回。`;
    result.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  } catch (error) {
    resultTitle.textContent = '暂时无法完成';
    resultBody.textContent = error?.message ?? '插件执行失败，请重试。';
    result.hidden = false;
    status.textContent = `操作失败：${error?.code ?? 'UNKNOWN_ERROR'}`;
  } finally {
    setBusy(false);
  }
}

function setBusy(value, command = '') {
  busy = value;
  toolbar.querySelectorAll('button').forEach((button) => {
    button.disabled = value;
    button.setAttribute('aria-busy', String(value && button.dataset.command === command));
  });
  if (value) status.textContent = '正在处理所选文字…';
}

function hideToolbar() {
  toolbar.hidden = true;
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
