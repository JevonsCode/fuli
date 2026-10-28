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
    "next.c.features.1": "体检：FULI 自己检查客户端连接是否过期、迁移是否在等你、会话是否还在用旧版、上次更新有没有做完；能自动修的点一下就修好，修不了的告诉你去哪里处理。控制台顶部显示「有 N 件事需要你」。",
    "next.c.features.2": "Windows 安装包的托盘换成 FULI 桌面客户端：一句话告诉你 FULI 是否正常，每件事一张卡片一个按钮，托盘圆点变色，情况变差时发系统通知；默认开机启动，可在托盘菜单关闭。",
    "next.c.features.3": "一键更新和回退会先关掉客户端，做完再打开；卸载会关掉它并删掉开机启动项。从 0.22 的旧托盘一键更新过来，打开的就是新客户端。",
    "next.c.changes": "变化",
    "next.c.changes.1": "完成的数据迁移提醒最多显示 7 次，可以单独关闭；彩色终端里突出显示可以复制的地址和命令。",
    "next.c.changes.2": "控制台里所有开关换成同一种组件；客户端的颜色和字号来自控制台主题。",
    "next.c.upgrade": "升级前要知道",
    "next.c.upgrade.1": "新增一个兼容的本地存储 format-notice-delivery.json，从 0.22.0 升级不需要确认迁移。",
    "next.c.upgrade.2": "桌面客户端还没在真实桌面上验证过托盘、通知和开机启动；macOS 版客户端还不在发布包里。",
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
    "next.c.features.1": "Health check: FULI checks for stale client connections, migrations waiting for you, sessions on an older version and unfinished updates. One click fixes what it can; for the rest it tells you where to go. The console shows “N things need you” at the top.",
    "next.c.features.2": "The Windows package’s tray app is now the FULI desktop client: one sentence on whether FULI works, a card with one button per thing that needs you, a tray dot that changes colour and a notification when things get worse. It launches at login by default; turn that off in the tray menu.",
    "next.c.features.3": "One-click update and rollback close the client first and open it again afterwards; uninstall closes it and removes its launch-at-login entry. A one-click update from the 0.22 tray opens the new client.",
    "next.c.changes": "Changed",
    "next.c.changes.1": "Completed migration notices appear up to seven times and can be dismissed one by one; colour terminals highlight copyable addresses and commands.",
    "next.c.changes.2": "Every console switch is the same component; the client takes its colours and type sizes from the console theme.",
    "next.c.upgrade": "Before you upgrade",
    "next.c.upgrade.1": "One new compatible local store, format-notice-delivery.json; upgrading from 0.22.0 needs no confirmed migration.",
    "next.c.upgrade.2": "The desktop client’s tray, notifications and launch at login are not yet verified on a real desktop; the macOS client is not in the release yet.",
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
