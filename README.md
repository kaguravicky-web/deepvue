# Cluster Monitor

板块扩散扫描：在强势板块里找"前排已突破 + 后排正准备"的结构。
静态页面部署在 GitHub Pages，数据由本地脚本定期生成后提交。

## 结构

| 文件 | 职责 |
| --- | --- |
| `scripts/rules.js` | **状态定义的唯一事实源。** 基础指标 + 主状态 + 附加标签 + Leaders 排序。 |
| `scripts/rules_reference.py` | 同一套规则的 pandas 参考实现，接受 `ticker,date,open,high,low,close,volume,market_cap,etf_weight` 的 DataFrame。 |
| `scripts/sync-screener-feed.mjs` | 取行情 → 调用 `rules.js` → 写 `public/screener-feed.json`。**不含任何判定逻辑。** |
| `index.html` | 单文件前端，只渲染 feed 里已经算好的状态，不在浏览器里二次推导。 |
| `tests/rules.test.mjs` | 每条规则的正例与反例。 |
| `tests/test_rules_parity.py` | 证明 JS 与 Python 两套实现逐条一致。 |

规则只写在 `scripts/rules.js` 一处。`sync` 脚本、页面渲染、页面上的阈值说明全部由它派生——
页面的"扫描规则"区块直接读 feed 里的 `params`，改了参数文案会跟着变，不需要手工同步。

## 状态定义

主状态互斥，按 **Fakeout → Breakout → Holding → Setup → Watch** 的优先级依次判定，命中即停。
`Spring` 与 `Tight` 是并行的附加标签，与主状态无关。

- **Setup** — 收盘 > SMA20 且 > SMA50；距 20 日最高价 0–5%；15D Range ≤ 12%；3 个月涨幅 > 8%。
- **Breakout** — 收盘突破**前一日**的 20 日最高价；RVOL ≥ 1.5；收盘位置 ≥ 60%。该 20 日高即 pivot。
- **Holding** — 过去 10 个交易日内有过有效 Breakout，且最新收盘同时站在该 pivot 与 21EMA × 0.98 之上。
- **Fakeout** — A：日内刺穿 pivot 但收盘跌回其下，RVOL ≥ 1.5 且收盘位置 < 50%；
  或 B：过去 1–5 日的有效 Breakout 现已跌回 pivot 之下。
- **Spring**（标签）— 最近 12 日内下破前 5 日最低点 0 至 −6%；其后 1–5 日收复该支撑，
  且收复当日涨幅 ≥ 4%、收盘位置 ≥ 45%、RVOL ≥ 1.15；当前价仍高于收复日收盘且支撑未再失守。
- **Tight**（标签）— 满足 Setup 的**全部条件**且 15D Range < 8%。判据是 Setup 条件本身，
  因此 Breakout 状态的股票同样可以带 Tight。
- **Leaders** — 资格池为 Setup / Breakout / Holding，以及带 Spring 标签的 Watch；Fakeout 一律无资格。
  排序值 = 市值 × (1 + ETF 权重 ÷ 5)，每个板块最多 3 只。

阈值集中在 `scripts/rules.js` 的 `PARAMS`。

## 命令

```bash
npm test            # 规则单元测试
npm run test:parity # JS / Python 一致性
npm run sync        # 重新抓数据并生成 public/screener-feed.json
npm run lint
```

`sync` 需要 `.env.local` 提供 `LONGPORT_APP_KEY` / `LONGPORT_APP_SECRET` /
`LONGPORT_ACCESS_TOKEN`（脚本会自动接受 `LONGBRIDGE_*` 前缀），以及板块排名所在的
Google Sheet ID。ETF 成分与权重来自 `LOCAL_ETF_HOLDINGS_CSV` 指向的 CSV。

## 口径说明

- **距 20 日高** = (Highest_20D − 收盘) ÷ Highest_20D × 100，即"低于高点的百分比"。
- **Highest_20D 含当日**；判定 Breakout / Fakeout 时用的是**前一日**的 Highest_20D。
- **RVOL** 的 50 日均量**含当日**。
- **零振幅日**（最高 = 最低）的收盘位置记为 100。
- **EMA21** 以首个收盘价作种子（等同 pandas `ewm(span=21, adjust=False)`），两套实现因此逐条对齐。
- **票池**要求 50 日日均成交额 ≥ $20M。
- **Cluster Score** 用于集中注意力，不是买入信号；它不属于上面的状态规范。
