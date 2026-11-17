// Authored copy for the preview page: the stable home page copy with this preview on top.
// A preview adds its chapter copy and scene labels here and rewrites the change cards;
// to promote the preview to the home page, fold these entries into ../translations.js.
import * as home from "../translations.js";

const copy = {
  "zh-CN": {
    "meta.title": "FULI 复利 抢先体验 · 下一版预览",
    "meta.description": "FULI（FULI AI）下一版的公开预览：涵盖 FULI Agent 与 FULI context 相对稳定版 0.27.16 的全部新功能和变化；每个平台一条命令装上 beta。",
    "meta.social": "FULI 下一版预览：相对稳定版的全部新功能，一条命令装上 beta。",
    "nav.changes": "全部变化",
    "copy.label": "复制预览版安装命令",
    "hero.description": "这是下一版的公开预览，给愿意先试新功能的人用。下面列出它相对稳定版 0.27.16 的全部变化。",
    "next.home": "Fuli 复利 预览版首页",
    "next.eyebrow": "抢先体验 · npm beta",
    "next.description": "这里列出这个预览版相对当前稳定版 0.27.16 的全部新功能和变化，不只是比上一个 beta 多了什么。发布前会跑完整的自动测试，但还没有经过稳定版那样的长期使用；遇到问题，请在 GitHub 提 issue。",
    "next.changes": "相对稳定版 0.27.16 的全部变化",
    "next.c.features": "新功能",
    "next.c.features.1": "另一台电脑可以当「运行机」：上面的客户端都用这台电脑的 FULI，知识和记忆只存一份。",
    "next.c.features.2": "主机不在时运行机约 5 秒内应答，任务记录先排队，连上后补交、只记一次；不想用了就 fuli runner leave。",
    "next.c.changes": "变化",
    "next.c.changes.1": "运行机发起的请求在这台电脑上一律只读；被撤销就立刻停用。没配对运行机的电脑什么都不多做。",
    "next.c.upgrade": "升级前要知道",
    "next.c.upgrade.1": "圆桌数据第一次启动时从第 11 版升到第 12 版，先自动备份；之后 0.27.16 及更早的 FULI 打不开它，退回要用备份。",
    "next.installTitle": "装上预览版",
    "next.clientTitle": "下载客户端（推荐）",
    "next.clientDescription": "双击安装，不用终端。Node.js、图数据库都已内置。已经装过 FULI 的，安装包会直接更新，数据保留。",
    "next.clientWindows": "下载 Windows 版",
    "next.clientMacDownload": "下载 macOS 版（Apple 芯片）",
    "next.clientMac": "macOS 版需要 Apple 芯片和 macOS 13.5 以上，暂未签名：第一次打开被拦下时，到「系统设置 › 隐私与安全性」点「仍要打开」。",
    "next.terminalTitle": "用终端安装",
    "next.installDescription": "已经装了 FULI 的话，先运行 fuli stop，并备份数据目录。下面的命令用原来的安装脚本，只是把安装的包换成 fuli-context@beta，装完会接着运行 fuli setup。",
    "next.switchBack": "想回到稳定版：去掉 FULI_NPM_PACKAGE_SPEC 再运行一次安装脚本。稳定版的版本号更低，原生 Provider 需要 fuli setup --allow-provider-downgrade。预览版升级过的数据（自动升级的，和你确认过的迁移），旧版本打不开，只能用升级前的备份恢复。",
    "next.release": "这一版的更新说明",
    "next.stable": "回到稳定版",
    "next.stableUrl": "https://xn--8ovp9s.xn--m8txu.com/fuli/",
    "next.stableSite": "稳定版网站",
  },
  "en": {
    "meta.title": "FULI Preview · The next release",
    "meta.description": "The public preview of the next FULI (FULI AI) release: everything new or changed in FULI Agent and FULI context since stable 0.27.16. One command per platform installs the beta.",
    "meta.social": "The next FULI release in preview: everything new since stable, installed with one command.",
    "nav.changes": "What changed",
    "copy.label": "Copy the preview install commands",
    "hero.description": "A public preview of the next release, for people who want new features first. Below is everything it changes since stable 0.27.16.",
    "next.home": "Fuli preview home",
    "next.eyebrow": "Preview · npm beta",
    "next.description": "Everything this preview adds or changes compared with the current stable release, 0.27.16, not just what changed since the last beta. The release runs the full automated test suite before it is published, but it has not had the long real-world use a stable release has. Please report problems as GitHub issues.",
    "next.changes": "Everything that changed since stable 0.27.16",
    "next.c.features": "New",
    "next.c.features.1": "Another computer can be a runner: its clients use this computer’s FULI, with one copy of knowledge and memory.",
    "next.c.features.2": "With the host away a runner answers in about 5 s and queues checkpoints, delivered once later; fuli runner leave ends it.",
    "next.c.changes": "Changed",
    "next.c.changes.1": "A runner’s asks stay read-only here, and a revoked runner stops at once. A computer without a runner does nothing extra.",
    "next.c.upgrade": "Before you upgrade",
    "next.c.upgrade.1": "The roundtable data upgrades from format 11 to 12 on first start, with a backup first; 0.27.16 and older cannot open it, so going back needs that backup.",
    "next.installTitle": "Install the preview",
    "next.clientTitle": "Download the app (recommended)",
    "next.clientDescription": "Double-click to install, no terminal. Node.js and the graph database are built in. If FULI is already installed, the setup updates it and keeps your data.",
    "next.clientWindows": "Download for Windows",
    "next.clientMacDownload": "Download for macOS (Apple silicon)",
    "next.clientMac": "The macOS app needs Apple silicon and macOS 13.5 or later. It is not signed yet: when it is blocked the first time, open System Settings › Privacy & Security and choose Open Anyway.",
    "next.terminalTitle": "Install from the terminal",
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
