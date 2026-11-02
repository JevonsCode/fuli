---
name: migrating-legacy-fuli-data
description: 把很早版本 FULI 的数据（Docker 容器里的图数据库，或更早的 context.db）迁移到当前内置图数据库。FULI 设置里的「一键迁移」失败、或用户从很老的版本升级上来时使用。
---

# 迁移旧版 FULI 数据

你是帮用户迁移数据的 AI。这份指南写得很细，**请严格按顺序做，不要跳步，不要自由发挥**。

## 0. 铁律（任何一步都不能违反）

1. **不删除任何东西**：不删 Docker 卷（volume）、不删数据目录、不删 `backups/` 里的任何文件、不运行 `docker volume rm`、`docker system prune`、`rm -rf` 之类的命令。
2. **先备份再动手**：第 2 步的备份没成功，就不要往下走。
3. **看不懂就停**：命令输出和本文写的不一样、报错本文没提到，就停下来，把**完整输出**原样告诉用户，并建议用户到 https://github.com/JevonsCode/fuli/issues 提问题。不要猜。
4. **每一步都告诉用户**：做了什么、看到了什么（一两句话即可）。
5. 不把用户数据、日志、令牌（token）、密码发到任何网站。

## 1. 先弄清楚现在的情况

### 1.1 找到 FULI 数据目录

| 系统 | 默认数据目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Fuli`（一般是 `C:\Users\<用户名>\AppData\Local\Fuli`） |
| macOS | `~/Library/Application Support/Fuli` |
| Linux | `~/.local/share/fuli` |

如果用户设置过环境变量 `FULI_DATA_DIR`，以它为准。下面用 `<数据目录>` 代指它。

### 1.2 看 FULI 版本和运行方式

依次运行，把结果记下来：

```bash
fuli --version
fuli status
```

Windows 托盘版如果没有 `fuli` 命令，用安装目录里的：
`"<安装目录>\runtime\node\node.exe" "<安装目录>\src\cli.js" --version`（下面所有 `fuli ...` 都可以这样替换）。

再看两个文件（只读，用文本方式打开即可）：

- `<数据目录>/runtime-settings.json` 里的 `graphRuntimeMode`：`"container"` 表示还在用 Docker，`"native"` 表示已用内置图数据库。
- `<数据目录>/graph-migration.json`（可能不存在）：上次一键迁移的结果，`status` 和 `error` 字段说明它怎么结束的。

### 1.3 看有没有旧的 Docker 数据

```bash
docker volume ls
```

找名字里带 `fuli-graphiti` 的卷，例如 `fuli-graphiti_personal_neo4j_data`、`fuli-graphiti_workspace_neo4j_data`。

`docker` 命令不存在或报「无法连接 Docker」时，记下来，看第 3 节的情况 C。

### 1.4 看有没有更早的 context.db

`<数据目录>/context.db` 存在，说明用户用过 0.7.1 及更早的版本（那时知识存在一个 SQLite 文件里）。看第 3 节的情况 D。

## 2. 备份（必须先做）

1. 先停掉 FULI：

   ```bash
   fuli stop
   ```

   托盘版也可以右键托盘图标 →「退出」。
2. 把整个 `<数据目录>` 复制一份到别处，例如桌面上的 `Fuli-backup-<今天日期>`。只复制，不移动。
3. 确认副本大小和原目录差不多，再继续。

Docker 卷里的数据会在迁移时由 FULI 自动导出成文件（放在 `<数据目录>/backups/graph/`），而且迁移只读取卷、不改它，所以不需要你手动备份卷。

## 3. 按情况处理

先对照下面的表，找到用户属于哪种情况，**只做那一种**。

| 情况 | 判断依据 |
| --- | --- |
| A | `graphRuntimeMode` 是 `container`，Docker 能用 |
| B | `graphRuntimeMode` 是 `native`，但 `docker volume ls` 里还有 `fuli-graphiti_*_neo4j_data` 卷，而且用户说「升级后知识不见了 / 变少了」 |
| C | `graphRuntimeMode` 是 `container`，但电脑上没有 Docker 或 Docker 起不来 |
| D | 有 `<数据目录>/context.db` |
| E | 迁移成功了，但 FULI 提示「数据格式更新等你确认」 |

### 情况 A：还在用 Docker，Docker 能用

1. 打开 Docker Desktop（或 Rancher Desktop），等它显示正在运行。
2. 运行：

   ```bash
   fuli graph migrate --to native --yes
   ```

   它会依次做这些：
   1. 停掉 FULI。
   2. 数一遍 Docker 里的数据并导出。
   3. 装好内置图数据库并导入。
   4. 再数一遍，每类节点和关系的数量都完全一致才算成功。

   任何一步失败都会自动切回原来的 Docker 数据，原数据不会动。
3. 看最后几行输出：
   - 有 `Fuli now runs on the native graph runtime` 就是成功了，跳到第 4 节验证。
   - 有 `Fuli is back on the unchanged container graph` 表示失败并已退回，把完整输出给用户看。常见原因如下：

| 输出里有 | 处理 |
| --- | --- |
| `docker` / `daemon` / `Cannot connect` | Docker 没启动。启动 Docker Desktop 后重跑第 2 步。 |
| `pull` / `network` / `timeout` | 第一次需要下载 `neo4j:5.26-community` 镜像，网络不通。换网络或配置 Docker 镜像源后重跑。 |
| `does not match the container graph` | 数量对不上，已自动退回。不要重试第二次，把输出原样交给用户去提问题。 |
| `no built-in Neo4j runtime`（Windows） | 用的不是托盘安装包里的 FULI。请用户先从官网下载安装最新的 FULI-Setup.exe，再从安装目录运行这条命令。 |
| `store` / `version` / `incompatible` | Docker 里的 Neo4j 版本和内置的不一样，导入不了。停下来，把输出交给用户去提问题。 |

### 情况 B：已经切到内置，但旧数据还在 Docker 里

这通常是以前在设置里直接把「运行方式」切成了原生，内置图数据库是空的，旧知识还在 Docker 卷里。

1. **先把内置图数据库里现在的东西导出备份**（切换后可能又记了新内容）：

   ```bash
   fuli graph export --mode native --output "<桌面>/fuli-native-now"
   ```

2. 打开 `<数据目录>/runtime-settings.json`，只把 `"graphRuntimeMode": "native"` 改成 `"graphRuntimeMode": "container"`，其他内容一个字都不改，保存。
3. 启动 Docker Desktop，然后：

   ```bash
   fuli setup --yes --skip-agents --runtime-mode container
   fuli status
   ```

   确认能看到旧知识（用户在控制台里搜一个以前记过的东西）。
4. 按**情况 A** 的第 2、3 步迁移。
5. 第 1 步导出的那份「切换后新记的内容」不会自动合并。告诉用户：这份导出在 `<桌面>/fuli-native-now`，如果里面有重要的新内容，需要在 FULI 里重新记一次。不要用 `fuli graph import` 把它导回去，那会覆盖刚迁移好的旧知识。

### 情况 C：要迁移，但没有 Docker

旧知识在 Docker 的虚拟磁盘里，没有 Docker 读不出来。

1. 问用户 Docker Desktop 是不是被卸载了。
2. 如果是，请用户重新安装 Docker Desktop（https://www.docker.com/products/docker-desktop/），**安装时不要选「清除数据」**。装好后运行 `docker volume ls`：
   - 能看到 `fuli-graphiti_personal_neo4j_data`：按**情况 A** 做。
   - 看不到：卸载时数据已经被 Docker 清掉了，FULI 这边没有办法找回。如实告诉用户，不要尝试其他「恢复」手段。

### 情况 D：有 context.db（0.7.1 及更早）

这是最早的存储格式，当前 FULI 不能直接导入。做法是把里面的知识整理成 Markdown，让 FULI 读到。

1. 确认已做第 2 节的备份。**只读打开** `context.db`，不要写它。
2. 用任意 SQLite 工具（例如 `sqlite3` 命令行）导出当前有效的知识：

   ```bash
   sqlite3 -readonly "<数据目录>/context.db" "SELECT subject, predicate, object, valid_at FROM facts WHERE invalid_at IS NULL ORDER BY subject, valid_at;"
   ```

   没有 `sqlite3` 时，可以用 Python：

   ```bash
   python -c "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro', uri=True); [print('\t'.join(map(str,r))) for r in c.execute('SELECT subject, predicate, object, valid_at FROM facts WHERE invalid_at IS NULL ORDER BY subject, valid_at')]" "<数据目录>/context.db"
   ```

3. 把结果整理成 Markdown 文件，按 `subject` 分组，每条一行：

   ```markdown
   # 旧版 FULI 知识（从 context.db 导出，<日期>）

   ## <subject>
   - <predicate>：<object>（<valid_at>）
   ```

   保存到一个新文件夹，例如 `<文档>/fuli-old-knowledge/old-knowledge.md`。不要改写内容，不要「补全」或「推测」原来没有的信息。
4. 让 FULI 用上这些内容，二选一：
   - **推荐**：在 FULI 控制台的「设置 › 外部知识」里，添加一个 Markdown 文件夹连接，指向上面那个文件夹。FULI 会把它当作可搜索的知识来源。
   - 用户想把其中重要的条目正式记进 FULI：在接入了 FULI 的 AI 客户端里，**一次只挑几条**，按 FULI 的正常记录流程保存，并让用户确认每一条。
5. `episodes` 表里是当年的原始对话片段，量大且杂，默认不导出。用户明确要求时再导，同样只读。

### 情况 E：迁移后提示「数据格式更新等你确认」

很老的图数据迁过来后，有些字段需要补齐，FULI 会先给用户看再执行。

1. 让用户在 FULI 控制台打开「设置 › 数据格式」，看清楚要改什么，点确认。
2. 用户更习惯命令行的话：

   ```bash
   fuli migrate preview
   fuli migrate apply --digest <上一步输出里的 digest>
   ```

   `apply` 会先自动备份，再执行；它会在终端里请用户确认，**由用户自己输入确认**，你不要替用户确认。

## 4. 验证

1. `fuli status`：图数据库状态正常。
2. 打开 FULI 控制台，在「沉淀」里搜一两个用户记得的旧知识，能搜到。
3. 设置里不再出现「迁移到内置图数据库」。
4. 体检（控制台顶部提示）里不再有「知识还在旧版 Docker 图数据库里」。

全部通过后告诉用户：

- 迁移完成。
- Docker 里的旧卷没有删，还在原处。
- 导出文件在 `<数据目录>/backups/graph/` 里。
- 用一段时间确认没问题后，用户**可以自己**决定是否删除旧卷和备份。你不要替他们删。

## 5. 出问题时收集信息

要给用户或开发者看的信息（发之前把用户名、路径里的个人信息遮掉）：

- `fuli --version` 的输出
- 第 1 节里 `graphRuntimeMode` 的值
- `<数据目录>/graph-migration.json` 的内容
- `<数据目录>/logs/graph-migration.log` 的最后 100 行
- 你运行的命令和它的完整输出

FULI 控制台「设置 › 诊断包」可以一键生成这些信息（会自动隐藏用户名、令牌等），优先用它。
