# baw-monitor

本機 Node 程式：監控幣安 Agent ID 專屬項目，並用官方 `baw` CLI 做 `contract-call preview` → 安全檢查 → `execute`。**不碰私鑰。**

發現來源預設是 hybrid：官方 Open Four / meme-rush 為主，鏈上新合約、熱度、鑄造事件作補助。打或不打只看 `config.toml` 裡的宣告式政策，沒有寫死「免費只通知／全自動」。

通知以 **Discord webhook** 為主（可略過），Telegram 為選用。沒設就只寫 log。

## 需求

- Node.js ≥ 22
- 已安裝並可執行 `baw`（幣安 Agentic Wallet CLI）
- 錢包已領 Agent ID（幣安 App 裡的 `.ai` 網域）；內盤交易需開啟開發者模式
- Discord webhook 可選（個人通知）

## 設定

設定檔是 `config.toml`（可寫註解）。範例在 `config.example.toml`。

**不必事先 `cp`，也不必手填錢包名稱或地址。** 直接：

```bash
npm start
```

若還沒有 `config.toml`，程式會從範例複製（佔位符可先留著），然後：

1. 做 baw 登入（沒登入就印連結、等手機確認）
2. 登入後用官方 CLI 自動帶入並寫回 `config.toml`（保留註解）
   - `baw wallet agent-id --json` → `wallets[].name`（Agent ID，例如 `alice.ai`；若只回 handle 會自動加 `.ai`）
   - `baw wallet address --json` → BSC（`binanceChainId` 56）地址
3. 顯示帶入結果給你確認；預設不必再填，要改可以手動覆寫
4. TTY 下進入選單；選「開始監控」才掃描。非 TTY／CI 才直接開掃

**錢包名稱 = 幣安 Agent ID（`.ai` 網域）。** 用途：畫面上顯示、通知，以及少數鑄造函式要帶自己的 Agent ID tokenId（從 `.ai` 名稱算出）。這是在幣安 App（Web3 錢包 → Agent ID）領的，沒有就無法打內盤，程式不會假裝就緒。

Discord webhook 不是必要欄位，空著也能進選單／掃描；之後可在選單補，或測發送。

其餘欄位沿用範例預設與註解。非 TTY（CI、背景）不會卡住問問題：已登入且身分帶入成功就直接開掃；未登入會清楚退出。

若還有舊的 `config.json`，啟動時會一次性讀入並寫進 `config.toml`，之後以 toml 為準。

### Discord

```toml
[discord]
webhook = "https://discord.com/api/webhooks/123/token"  # 個人通知
# alert_webhook = ""  # 可選：硬擋、登入失效、確認請求等另發一個
```

沒設 Discord 也沒設 Telegram 就只寫 log。每則 webhook 訊息最長 2000 字，超過會切割；重要事件用 embed。

### 其他區塊

| 區塊 | 用途 |
|---|---|
| `wallets` | 名稱（Agent ID / `.ai`）與 BSC 地址，登入後自動帶入。可選 `bawDir` / `instanceId` 給多錢包 |
| `telegram` | 選用：botToken、chatId、可選 groupChatId |
| `discovery` | 各來源開關：`memeRush` / `newContracts` / `heat` / `mintEvents` |
| `execution` | **免費與付費分開**的執行模式 |
| `thresholds` | 進度％、Agent ID 錢包數、是否要求每錢包上限 |
| `budget` | 每項目上限、每日上限、保留 gas（BNB） |
| `sell` | `backX` / `steps` / `crash` / `crashAfterBack` / `moonPct` |
| `forceMint` | 強制列入的合約（仍走 preview 安全檢查） |
| `tokens` | 手動持倉 |
| `rpcs` | 自備 BSC RPC；空白則用預設公共節點 |
| `official` | 可選官方 script／meme-rush CLI 路徑、滑點、內盤買入 BNB |

### 執行模式

`execution.free` 與 `execution.paid` 各自可設：

| 值 | 行為 |
|---|---|
| `notify` | 達門檻只發結構化事件，不 preview / execute |
| `confirm` | 達門檻通知，等你回覆 `打 0x合約` 才執行（需 Telegram） |
| `auto` | 達門檻後自動 preview → 模擬檢查 → execute |

預設建議（已寫在 example）：**免費 = `notify`，付費 = `auto`。**

付費定義：要付 BNB / USDT / NFT，或官方 bonding curve（Open Four `AgentIdExclusive`）。

## 啟動

```bash
npm start
```

一次做完：

1. 檢測／建立 `config.toml`（佔位符可留著，不必先填名稱、地址、webhook）
2. 檢測 baw 登入；未登入就印連結、等待手機確認
3. 登入後自動帶入 Agent ID（`.ai`）與 BSC 地址，寫回設定檔
4. 檢測開發者模式與 Agent ID；缺少會明白告訴你要手動開／領，**不會假裝已就緒**
5. TTY：進入互動選單。選 1 才開始監控；2–6 改完立刻寫回 `config.toml`（保留註解）
6. 非 TTY／CI：身分通過後直接進入監控主迴圈

選單：

```
目前：錢包 alice.ai / 0xabc…   免費=notify  付費=auto   Discord=未設定
1) 開始監控
2) 執行模式（免費／付費：notify / confirm / auto）
3) 門檻與預算（進度％、Agent ID 錢包數、每項目／每日上限、保留 gas）
4) 賣出規則（backX / steps / crash / moonPct）
5) 發現來源開關（memeRush / newContracts / heat / mintEvents）
6) Discord webhook（可略過、可測發送）
7) 重新登入 baw／重新讀取錢包
8) 結束
```

`node login.mjs`（或 `node login.mjs 2`）仍可單獨重登，但主路徑不需要。

同資料夾放 `WATCH_STOP` 可優雅退出。同一工作區只允許一份主迴圈。

## 主路徑

1. **發現**：meme-rush（`protocol:2004` + `openfour.meme.AgentIdExclusive`）＋新合約／CREATE2＋熱度＋`Transfer(from=0)`
2. **登錄**：每個合約只有一份 `Project`（`data/projects.json`）
3. **分類**：bonding / free / bnb / usdt / replay；進度讀已售／上限，不合理值丟棄
4. **政策**：進度 + Agent ID 錢包數 + 預算 + 黑名單 + 抽光 + 批量部署
5. **執行**：typed adapter（官方 bonding / 已知 mint）或 replay（最後手段，限制更嚴）→ `baw preview` → 安全檢查 → `execute`
6. **持倉**：開池後依 `sell` 規則止盈；TG 指令賣／餘額／持倉／戰績

狀態拆成 `data/projects.json`、`positions.json`、`risk.json`、`session.json`。戰績只從這四份統計，不解析 log。

## 安全硬擋

preview 模擬出現以下任一情況就**不 execute**：

- 多餘授權（`allowanceChanges` 不在允許名單）
- 扣到預期外資產
- 淨拿到 0
- replay calldata 含他人地址且換成自己／零地址後仍失敗
- 扣的 BNB 比說好的多

所有交易只走官方 baw，本程式不簽名、不存私鑰。硬擋、確認請求、啟動資訊都會發到 Discord（若已設定）。

## 通知

事件帶 `type` 欄位（例如 `project.eligible`、`mint.executed`、`monitor.started`），**不用 emoji 正則分流**。

Telegram 指令（只聽 `chatId` 本人；Discord webhook 無法回指令）：

- `賣 XXX` / `賣 XXX 一半`
- `打 0x合約`（confirm 模式）
- `餘額` / `持倉` / `戰績` / `指令`

## 第一版不做

遠端自動更新、使用者 TG session 監聽群組、銘文自動打、ToshX / AIDROP 特例、一鍵安裝包。

## 測試

```bash
npm test
npm run check
```
