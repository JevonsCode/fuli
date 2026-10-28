// Authored copy for the preview page: the stable home page copy with this preview on top.
// A preview adds its chapter copy and scene labels here and rewrites the change cards;
// to promote the preview to the home page, fold these entries into ../translations.js.
import * as home from "../translations.js";

const copy = {
  "zh-CN": {
    "meta.title": "FULI 复利 抢先体验 · 下一版预览",
    "meta.description": "FULI 下一版的公开预览：相对稳定版 0.22.0 的全部新功能和变化；每个平台一条命令装上 beta。",
    "meta.social": "FULI 下一版预览：相对稳定版的全部新功能，一条命令装上 beta。",
    "nav.changes": "全部变化",
    "copy.label": "复制预览版安装命令",
    "hero.description": "这是下一版的公开预览，给愿意先试新功能的人用。下面列出它相对稳定版 0.22.0 的全部变化。",
    "next.home": "Fuli 复利 预览版首页",
    "next.eyebrow": "抢先体验 · npm beta",
    "next.description": "这里列出这个预览版相对当前稳定版 0.22.0 的全部新功能和变化，不只是比上一个 beta 多了什么。发布前会跑完整的自动测试，但还没有经过稳定版那样的长期使用；遇到问题，请在 GitHub 提 issue。",
    "next.changes": "相对稳定版 0.22.0 的全部变化",
    "next.c.features": "新功能",
    "next.c.features.1": "下一个预览版的新功能会列在这里。",
    "next.c.changes": "变化",
    "next.c.changes.1": "相对稳定版改了什么、去掉了什么，会列在这里。",
    "next.c.upgrade": "升级前要知道",
    "next.c.upgrade.1": "数据格式有没有变化、怎么退回，会写在这里。",
    "next.installTitle": "一条命令装上预览版",
    "next.installDescription": "已经装了 FULI 的话，先运行 fuli stop，并备份数据目录。下面的命令用原来的安装脚本，只是把安装的包换成 fuli-context@beta，装完会接着运行 fuli setup。",
    "next.switchBack": "想回到稳定版：去掉 FULI_NPM_PACKAGE_SPEC 再运行一次安装脚本。稳定版的版本号更低，原生 Provider 需要 fuli setup --allow-provider-downgrade。预览版升级过的数据（自动升级的，和你确认过的迁移），旧版本打不开，只能用升级前的备份恢复。",
    "next.release": "这一版的更新说明",
    "next.stable": "回到稳定版",
    "next.stableUrl": "https://xn--8ovp9s.xn--m8txu.com/fuli/",
    "next.stableSite": "稳定版网站",
  },
  "en": {
    "meta.title": "FULI Preview · The next release",
    "meta.description": "The public preview of the next FULI release: everything new or changed since stable 0.22.0. One command per platform installs the beta.",
    "meta.social": "The next FULI release in preview: everything new since stable, installed with one command.",
    "nav.changes": "What changed",
    "copy.label": "Copy the preview install commands",
    "hero.description": "A public preview of the next release, for people who want new features first. Below is everything it changes since stable 0.22.0.",
    "next.home": "Fuli preview home",
    "next.eyebrow": "Preview · npm beta",
    "next.description": "Everything this preview adds or changes compared with the current stable release, 0.22.0, not just what changed since the last beta. The release runs the full automated test suite before it is published, but it has not had the long real-world use a stable release has. Please report problems as GitHub issues.",
    "next.changes": "Everything that changed since stable 0.22.0",
    "next.c.features": "New",
    "next.c.features.1": "The next preview’s new features will be listed here.",
    "next.c.changes": "Changed",
    "next.c.changes.1": "What changed or was removed since stable will be listed here.",
    "next.c.upgrade": "Before you upgrade",
    "next.c.upgrade.1": "Data format changes and how to go back will be described here.",
    "next.installTitle": "Install the preview with one command",
    "next.installDescription": "If FULI is already installed, run fuli stop and back up the data folder first. These commands use the usual installers and only switch the package to fuli-context@beta; fuli setup runs afterwards.",
    "next.switchBack": "To return to stable, run the installer again without FULI_NPM_PACKAGE_SPEC. The stable version is lower, so a native Provider needs fuli setup --allow-provider-downgrade. Data the preview upgraded, automatically or through a migration you confirmed, cannot be opened by an older version; only the backup from before the upgrade restores it.",
    "next.release": "Release notes for this version",
    "next.stable": "Back to the stable release",
    "next.stableUrl": "https://xn--8ovp9s.xn--m8txu.com/fuli/en/",
    "next.stableSite": "Stable website",
  },
};

const scenes = {
  "zh-CN": {},
  "en": {},
};

const overlay = (base, top) => Object.fromEntries(Object.entries(base).map(([locale, entries]) => [locale, { ...entries, ...top[locale] }]));
export const messages = overlay(home.messages, copy);
export const sceneMessages = overlay(home.sceneMessages, scenes);
