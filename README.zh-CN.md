# pi-autothink

[English](README.md) · **中文**

[![npm](https://img.shields.io/npm/v/pi-autothink.svg)](https://www.npmjs.com/package/pi-autothink)
[![license](https://img.shields.io/npm/l/pi-autothink.svg)](./LICENSE)

> 一个给自己用的 [Pi](https://pi.dev) 扩展：**每条消息进来，先判这件事要想多深，再把这个模型的思考档位调到对应那一档。**
>
> 改一个错别字，和重构一整个鉴权层，不该花一样的思考预算。
>
> 模型不换、上下文不变、缓存还在。**动的只有档位。**

```
  你敲一条消息
        │
        ▼
  ┌─────────────────────────┐      0–5 分
  │  分类器（Jev）          │ ────────────────┐
  │  「这件事要多深？」      │                 │
  └─────────────────────────┘                 ▼
                                     ┌──────────────────┐
                                     │   思考档位        │
                                     │ 最低 … 最高       │
                                     └────────┬─────────┘
        ┌─────────────────────────────────────┘
        ▼
  按当前模型支持的档钳制 → 按这一档跑 → 决策写进会话
```

## 三步装上

```bash
pi install npm:pi-autothink          # 或：pi install git:github.com/loofare/pi-autothink
```

重启 Pi（或 `/reload`），然后确认它在跑：

```
/autothink status
```

**默认开启**。关掉用 `/autothink off`，或启动时 `PI_AUTO_THINKING=0`。

## 为什么要这个

Pi 把思考档位跟模型选择存在一起，所以它会一直停在你上次留下的位置。于是只有两种用法，都不太好：

| 习惯 | 代价 |
|---|---|
| 一直顶在最高 | 改错别字、查个名字，都在按"架构级思考"付钱：更慢、更贵，答案还不会更好 |
| 每条消息手动切 | 切档这件事本身就在占你的注意力，而且最容易在忙的时候切错 |

思考也是 token，一样按输出计费。这个扩展在每一轮前面加**一次很便宜的判档调用**，让档位跟着活走，而不是跟着心情走。

## 装之前先看

| 条件 | 说明 |
|---|---|
| Pi 支持分类器 | 需要 `ctx.modelRegistry.classify()` 这个接口，Pi 1.4.0 及以上 |
| 有一个分类器凭据 | 下面**任意一个**就行：`TYPESAFE_API_KEY`（Jev，优先）、`OPENROUTER_API_KEY` 或 `/login`、`CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`、`AI_GATEWAY_API_KEY`、`OPENCODE_API_KEY`、`OPENAI_API_KEY`（GPT-6 Luna） |
| 当前模型支持思考档 | 不支持时 Pi 会把档位钳到 `off`：不报错，但也没作用 |

**没有凭据也能跑**：分类器不可用、报错、或超过四秒没回，它会退回本地关键词判断，不会卡住你这一轮。

## 它怎么判

问分类器一个问题——*完成这条请求需要多少内部推理？看这件活本身，别被语气和长度带偏*——答案落在这六档上：

| 分数 | 这活长什么样 | 档位 |
|---:|---|---|
| 0 | 改变量名、格式化、跑一条已知命令 | `minimal` |
| 1 | 一处小改、随手查一下 | `low` |
| 2 | 普通功能、普通修复、普通解释 | `medium` |
| 3 | 跨好几个文件、不好查的 bug、要做设计决定 | `high` |
| 4 | 架构、找根因、安全、迁移 | `xhigh` |
| 5 | 很大系统里、动的是高风险的地方 | `max` |

两个关键的细节：

- **0 分给 `minimal`，永远不给 `off`。** 「干脆别想」这个决定留给你，不交给分类器。
- **结果会被钳制到当前模型支持的档。** 请求的档位会就近取到模型真有的那一档，不支持的档不会发到服务商那边。

请求文本截到 6000 字符，超时 4000 毫秒。

## 开关与配置

| 控制 | 作用 |
|---|---|
| `/autothink on` · `/autothink off` | 会话里开关 |
| `/autothink status` | 看开关状态、找到哪个分类器、当前档位、上一次判定 |
| `PI_AUTO_THINKING=0` | 这个进程关掉 |
| `pi --auto-thinking` | 这个进程强制开 |
| `PI_AUTO_THINKING_MODEL=provider/modelId` | 换一个分类器，例如 `openai/gpt-6-luna` |
| `PI_AUTO_THINKING_DEBUG=1` | 把每次判定打到 stderr |

## 它不做什么

边界说清楚，比以后排查便宜：

| 它不会… | 原因 |
|---|---|
| 换你的模型 | 只动档位，模型身份不变，前面攒的缓存还能用 |
| 一轮里反复改档 | 一条用户消息只判一次；这一轮里调多少次工具，档都不变 |
| 保证判得准 | 它读的是你写的那句话，不是这一轮最后实际要多难 |
| 拿不准就替你决定 | 判不出来就退回关键词，但这一轮一定放行 |
| 宣称省了多少 | 它报告的是一张分表，不是基准测试 |
| 进前台子代理 | 后台（async）子代理会各自判自己那条；`async: false` 的前台子代理不加载它，档位按自己的配置 |

## 审计

每次判定都会作为 `auto-thinking` 自定义条目写进会话——不进模型上下文，也不记录你的 prompt 内容、凭据或任何用户内容：

```json
{"requested":"medium","applied":"low","clamped":true,"source":"jev",
 "classifier":"typesafe/jev-latest","model":"some/model","detail":"jev 2.31/5"}
```

`requested` 是分类器说的，`applied` 是真正跑的，`clamped` 说明模型支持不了这个档。重试和恢复会复用上一次的判定，不重复调分类器。

## 几种装法

```bash
pi install npm:pi-autothink                          # npm
pi install git:github.com/loofare/pi-autothink        # git
pi install ./pi-autothink                            # 本地目录
pi -e /path/to/pi-autothink                          # 只试一次，不写进配置
```

## 许可

MIT
