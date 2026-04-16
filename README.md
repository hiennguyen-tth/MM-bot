# MM Bot v5 — Production Market-Making Bot

Market-making bot production-grade: 4 lớp risk pipeline, multi-level quoting, **microprice + regime-gated flow signal + adaptive AS inventory decay + funding bias + volume-based toxic flow filter (VPIN) + inventory-coupled dynamic sizing + queue-depth awareness + smart kill-switch**. Hỗ trợ Binance và BingX (spot + swap perpetual).

**Nguyên tắc cốt lõi**: Bot đặt lệnh hai chiều (bid/ask) liên tục, kiếm lợi nhuận từ spread. Mỗi giao dịch lãi nhỏ nhưng tần suất cao. Risk được kiểm soát bằng inventory skew, regime filter, toxic flow filter và circuit breaker.

---

## Mục lục

1. [Tổng quan kiến trúc](#tổng-quan-kiến-trúc)
2. [Vòng lặp giao dịch](#vòng-lặp-giao-dịch)
3. [Pipeline rủi ro 4 lớp](#pipeline-rủi-ro-4-lớp)
4. [Position Mode — BingX oneway vs hedge](#position-mode--bingx-oneway-vs-hedge)
5. [Tính năng v2 + v3 + v4 + v5](#tính-năng-v2--v3--v4--v5)
6. [Cấu hình hiện tại (mainnet swap)](#cấu-hình-hiện-tại-mainnet-swap)
7. [Quick Start](#quick-start)
8. [Telegram Alerts](#telegram-alerts)
9. [Config Reference](#config-reference)
10. [Hướng dẫn Exchange](#hướng-dẫn-exchange)
11. [Công thức spread & skew](#công-thức-spread--skew)
12. [P&L: Cách tính đúng với BingX](#pl-cách-tính-đúng-với-bingx)
13. [Tests](#tests)
14. [Logs & Monitoring](#logs--monitoring)
15. [Safety Checklist](#safety-checklist)

---

## Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MM Bot v4 — BingX Swap                            │
│                                                                             │
│  ┌──────────────┐  ┌─────────────────┐  ┌───────────────────────────────┐  │
│  │ SpreadEngine │  │  RegimeDetector │  │         QuoteEngine           │  │
│  │  6 layers:   │  │  ranging        │  │  N-level bid/ask              │  │
│  │  vol         │  │  trending_up    │  │  asymmetric tanh skew         │  │
│  │  imbalance   │  │  trending_down  │  │  fairPrice-centered           │  │
│  │  regime      │  │  volatile       │  └───────────────────────────────┘  │
│  │  adverse     │  └─────────────────┘                                     │
│  │  fill-rate   │                                                           │
│  │  inv-spread  │  ┌──────────────────────────────────────────────────┐    │
│  └──────────────┘  │    InventoryManager  (avg-cost VWAP, VaR cap)    │    │
│                    └──────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌──────────────────┐  ┌─────────────────────────────────────────────┐     │
│  │  CircuitBreaker  │  │                BingXAdapter                 │     │
│  │  T4: dailyLoss   │  │  REST (ccxt)         WebSocket (ccxt.pro)   │     │
│  │      consLoss    │  │  ├─ getOrderBook      └─ watchOrders()      │     │
│  └──────────────────┘  │  ├─ placeLimitOrder      → fills <100ms    │     │
│                         │  ├─ cancelOrder                            │     │
│  ┌──────────────────┐  │  ├─ getFundingRate     REST polling         │     │
│  │  TelegramAlert   │  │  └─ getPosition          (safety net)       │     │
│  │  shutdown alerts │  └─────────────────────────────────────────────┘     │
│  │  PnL digest      │                                                       │
│  └──────────────────┘                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Module | Vai trò |
|---|---|
| `MarketMaker` | Orchestrator vòng lặp chính — fetch dữ liệu, tính toán, đặt lệnh |
| `RegimeDetector` | Phân loại thị trường: ranging / trending_up / trending_down / volatile |
| `SpreadEngine` | 6 lớp spread: vol → imbalance → regime → adverse fill → fill-rate → inv-widening |
| `QuoteEngine` | Tạo N cặp bid/ask với asymmetric tanh-skew centered on fairPrice |
| `InventoryManager` | Giới hạn vị thế, weighted avg cost, VaR cap |
| `CircuitBreaker` | T4: daily loss / consecutive loss → shutdown |
| `TelegramAlert` | Push Telegram khi shutdown + báo cáo PnL định kỳ |
| `MetricsCollector` | Fill rate, PnL thực, drawdown, adverse ratio |
| `BingXAdapter` | REST (ccxt) cho order management; WebSocket (ccxt.pro) cho fill detection <100ms |

---

## Vòng lặp giao dịch

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │            WebSocket stream  (ccxt.pro.bingx — chạy nền)           │
  │  watchOrders() → _handleWsOrderUpdate() → _applyOrderUpdate()      │
  │  Fill detected < 100ms  ·  REST poll vẫn chạy làm safety net       │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │ concurrent với main loop
  ┌──────────────────────────────▼──────────────────────────────────────┐
  │                Main loop  (LOOP_INTERVAL_MS = 5s)                  │
  │                                                                     │
  │  B1  T4 CircuitBreaker                                              │
  │      dailyLoss > limit?  → SHUTDOWN + Telegram                     │
  │      consecutiveLoss > limit?  → SHUTDOWN (closing fills only)     │
  │                                                                     │
  │  B2  Fetch song song                                                │
  │      getOrderBook · getRecentTrades · getTrades · getFundingRate    │
  │                                                                     │
  │  B3  Intra-cycle gap check  (INTRA_CYCLE_MAX_MOVE = 0.003)         │
  │      |mid − prevMid| > 0.3%?  → cancel + pause (flash crash)      │
  │                                                                     │
  │  B4  Regime filter  (1-min window)                                  │
  │      |mid − mid_60s_ago| > 0.8%?  → cancel + pause 30s            │
  │                                                                     │
  │  B5  Toxic flow filter  (v4 count-based + v5 VPIN volume-based)       │
      │      sideRatio > 82% AND vwapDev > 4bps?  → skip cycle 3s         │
      │      volumeImbalance > 70% AND vwapDev > 4bps?  → skip cycle 3s  │
  │                                                                     │
  │  B6  SpreadEngine  (6 layers)                                       │
  │      L1 vol → L2 imbalance → L3 regime → L4 adverse → L5 fillrate │
  │      L6 INV_SPREAD_K × |invRatio|  (wider khi inventory skewed)   │
  │                                                                     │
  │  B7  T3 hedge  (if |inventory| > effectiveHardMax)                 │
  │      limit → poll 2s → market fallback                             │
  │                                                                     │
  │  B8  Fair price + T2 skew                                           │
      │      fairPrice = microprice + [regime-gated flowAdj] + invDecay   │
      │      volatile:  fairPrice = microprice + invDecay  (kill flow)    │
      │      trending:  + 1.5×flowAdj  (amplify momentum)               │
      │      ranging:   + 0.5×flowAdj  (dampen whipsaws)                │
      │      invDecay   = −γ×(1+|ratio|)×ratio×vol×mid  (adaptive AS)   │
      │      dynSizeMult = clamp(tVol/vol) × (1−|ratio|)^α  (inv couple)│
  │                                                                     │
  │  B9  Requote guard  (anti-ban BingX)                                │
  │      invSign đổi → force requote                                   │
      │      queueDepth > N bps → force requote  (v5 queue awareness)    │
      │      drift < 5bps AND age < 3min → carry forward                  │
      │      MAX_CANCEL_PER_MIN=4 · MIN_CANCEL_INTERVAL=45s               │
      │                                                                     │
  │  B9b v5 Smart kill-switch                                          │
      │      vol > VOL_THRESHOLD AND spread < vol×1.5 → SHUTDOWN          │
      │      fillRate < FILL_RATE_MIN after warmup → SHUTDOWN             │
  │                                                                     │
  │  B10 Place quotes → Cancel old  (place-before-cancel)              │
  │      oneway: positionSide=BOTH · hedge: LONG/SHORT per inventory   │
  │      amount = max(computed, MIN_ORDER_SIZE=0.0001)  [BingX floor]  │
  │                                                                     │
  │  B11 REST poll fallback  (mỗi 3s, trong 30s TTL)                   │
  │      getOrder() parallel → _applyOrderUpdate()                     │
  │      _processedQty guard → no double-count với WebSocket           │
  │      Latency drift > 0.2%? → cancel orders                        │
  │                                                                     │
  │  B12 Carry-forward  (if orders < 3min old → giữ lệnh cũ)           │
  │      Metrics + Telegram PnL digest → Sleep 5s → B1                 │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Pipeline rủi ro 4 lớp

```
     Fill xảy ra
          │
          ├──────────────────────────────────┐
          │  WebSocket (chạy nền)            │
          │  _handleWsOrderUpdate()          │ < 100ms
          │  _applyOrderUpdate(q, fill)      │
          └──────────────────────────────────┘
          │
          │  REST poll (safety net, mỗi 3s)
          │  _processedQty guard → skip nếu WS đã xử lý
          │
  ┌───────▼──────────────────────────────────────────────────────────┐
  │ T4 │ CircuitBreaker  │  dailyLoss > LIMIT?        → SHUTDOWN     │
  │    │                 │  consecutiveLoss > LIMIT?  → SHUTDOWN     │
  └───────┬──────────────────────────────────────────────────────────┘
          │
  ┌───────▼──────────────────────────────────────────────────────────┐
  │ T3 │ Hedger          │  |inventory| > effectiveHardMax?          │
  │    │  limit-first    │  → Limit tại mid±fee → timeout → Market  │
  └───────┬──────────────────────────────────────────────────────────┘
          │
  ┌───────▼──────────────────────────────────────────────────────────┐
  │ T2 │ InventoryMgr   │  Asymmetric tanh-skew + size reduction     │
  │    │  (VaR-aware)   │  effectiveHardMax = min(HARD_MAX, VaR cap) │
  └───────┬──────────────────────────────────────────────────────────┘
          │
  ┌───────▼──────────────────────────────────────────────────────────┐
  │ T1 │ SpreadEngine   │  adverseMultiplier = 1 + adverseFillRatio  │
  │    │  (adaptive)    │  Spread tự mở/thu theo fill quality         │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Position Mode — BingX oneway vs hedge

BingX có 2 chế độ vị thế. **Phải khớp** giữa `POSITION_MODE` trong `.env` và setting trong tài khoản BingX.

### Oneway Mode (mặc định — đang dùng)

```
positionSide = BOTH cho tất cả lệnh
Inventory có thể âm (short) hoặc dương (long) — BingX quản lý nội bộ
Không cần bật gì trong tài khoản
```

`POSITION_MODE=oneway` → lệnh buy/sell đều dùng `positionSide=BOTH`.

### Hedge Mode (tùy chọn)

```
positionSide = LONG cho lệnh long, SHORT cho lệnh short
LONG và SHORT là 2 bucket riêng biệt
Phải bật "Hedge Mode" trong Account Settings → Position Mode trên BingX
```

`POSITION_MODE=hedge` → bot tính `positionSide` theo chiều của inventory.

### ⚠️ Lỗi chỉ LONG (đã sửa — v4)

Nếu `POSITION_MODE=hedge` nhưng tài khoản đang ở oneway:
- Lệnh sell với `positionSide=SHORT` bị BingX từ chối (error "No position to close")
- Chỉ lệnh buy/LONG thành công
- Bot tích lũy LONG không kiểm soát được → thua lỗ khi thị trường giảm

**Fix**: Dùng `POSITION_MODE=oneway` (mặc định). Chỉ đổi sang `hedge` nếu đã bật Hedge Mode trong tài khoản BingX.

---

## Tính năng v2 + v3 + v4 + v5

### Orderbook Imbalance Spread

```
imbalance = (bidVolume - askVolume) / (bidVolume + askVolume)
spread    = max(vol_spread, IMBALANCE_FACTOR × |imbalance|)
```

### Asymmetric Inventory Skew

```
Long (muốn sell):   bid thấp xuống, ask lên cao  → inventory tự giảm
Short (muốn buy):   bid lên cao,   ask thấp xuống → inventory tự tăng
```

Sử dụng tanh để bão hòa khi ratio gần max — tránh spread cực đoan khi cần fill nhất.

### Multi-level Quoting (QUOTE_LEVELS=2)

```
L1: spread × 1.0  ×  50% size   ← tight, fill rate cao nhất
L2: spread × 1.5  ×  30% size   ← passive insurance
```

### Regime Filter

Pause quoting khi BTC di chuyển > 0.8% trong 1 phút. Bảo vệ khỏi downtrend tích lũy inventory thua lỗ.

### Requote Guard (chống ban)

Chỉ cancel+replace khi:
- Inventory sign đổi chiều (cần requote ngay để tránh lệnh stale)
- Giá drift > 5 bps (REQUOTE_PRICE_THRESHOLD=0.0005)
- Lệnh cũ hơn 3 phút (MAX_ORDER_AGE_MS=180000)
- Cancel cooldown đã đủ (MIN_CANCEL_INTERVAL_MS=45000, MAX_CANCEL_PER_MIN=4)

### v3.1 Microprice, v3.2 Flow Signal, v3.3 Fill-rate Feedback, v3.4 tanh Skew, v3.5 Inventory Decay

Xem công thức tại phần [Công thức spread & skew](#công-thức-spread--skew).

### v4.1 — Inventory-based Spread Widening

```
invSpreadAdj = INV_SPREAD_K × |invRatio|
effectiveSpread += invSpreadAdj
```

Khi inventory lệch nhiều (|ratio| cao), spread mở rộng thêm để bảo vệ rủi ro tồn kho. `INV_SPREAD_K=0.0006` → thêm tối đa 6 bps khi ratio=1.

### v4.2 — Dynamic Size ∝ 1/vol

```
vol         = stddev(last_N prices) / mid
sizeMult    = clamp(DYN_SIZE_TARGET_VOL / vol, 0.5, 2.0)
effectiveQty = BASE_SIZE × sizeMult × levelFraction
```

Thị trường ít biến động → size lớn hơn (nhiều fill hơn). Thị trường biến động mạnh → size nhỏ hơn (giảm exposure).

### v4.3 — Funding Rate Bias

```
fundingRate = getFundingRate()      [8-hour funding rate BingX]
fundingAdj  = −FUNDING_BIAS_K × fundingRate × mid
fairPrice   += fundingAdj
```

Funding dương cao (long trả tiền) → fairPrice giảm → bot nghiêng về short → cân bằng tự nhiên với chi phí funding.

### v4.4 — Toxic Flow Filter

```
trades       = getRecentTrades(last 50)
sideRatio    = trades cùng chiều nhiều nhất / tổng trades
vwapDev      = |trade_vwap − mid| / mid
isToxic      = sideRatio > TOXIC_FLOW_SIDE_RATIO (0.82)
             AND vwapDev > TOXIC_FLOW_VWAP_THRESHOLD (0.0004)
```

Nếu 82%+ giao dịch cùng chiều và VWAP lệch >4bps → đây là flow directional (không phải spread capture) → pause 3s, bỏ qua cycle.
### v4.5 — WebSocket fill detection

```
BingXAdapter (ccxt.pro):
  start()  →  watchOrders(symbol, callback)   [chạy nền, infinite loop]
               ↓ BingX gửi order update event
            _handleWsOrderUpdate(order)
               ↓ tìm order trong _openOrders theo id
            _applyOrderUpdate(q, order, source='websocket')
               ↓ _processedQty guard → no double-count

REST poll:  _pollFills() → getOrder() → _applyOrderUpdate(source='poll')
            Vẫn chạy mỗi 3s làm safety net.
            Nếu WS đã xử lý fill trước → newFill = 0 → no-op.
```

Fill latency: **< 100ms** (WS) vs **~1.5s avg** (REST poll). Inventory tracking chính xác hơn, đặc biệt khi nhiều lệnh fill gần nhau.

### v5.1 — Regime-gated Fair Price

Thay vì áp dụng flow signal đồng đều, v5 điều chỉnh trọng số theo regime:

```
volatile:            fairPrice = microprice + invDecay      (bỏ flow, quá nhiễu)
tending_up/down:     fairPrice = microprice + 1.5×flowAdj + invDecay  (khuếch đại momentum)
ranging:             fairPrice = microprice + 0.5×flowAdj + invDecay  (giảm whipsaw)
```

### v5.2 — Adaptive AS Inventory Decay

Gamma tự động tăng khi vị thế lớn:

```
γ_eff = INVENTORY_DECAY_GAMMA × (1 + |ratio|)
invDecay = −γ_eff × ratio × vol × mid
```

Tại ratio=0: γ_eff = γ_base (bình thường). Tại ratio=1: γ_eff = 2×γ_base (kéo mạnh hơn về mid).

### v5.3 — Volume-based Toxic Flow (VPIN)

Bổ sung phát hiện dựa trên volume (cạnh count-based cũ):

```
buyVol = tổng volume của buy trades
sellVol = tổng volume của sell trades
volumeImbalance = |buyVol − sellVol| / (buyVol + sellVol)

isToxic = (sideRatio ≥ 0.82 AND vwapDev ≥ 4bps)   ← count-based (v4)
        OR (volumeImbalance ≥ 0.70 AND vwapDev ≥ 4bps)  ← VPIN (v5)
```

Bắt được sweep nhỏ về số lượng trade nhưng lớn về volume (whale với ít transaction).

### v5.4 — Queue Position Awareness

Force requote khi lệnh resting bị đẩy ra xa top-of-book:

```
bidGap = (currentBestBid − myBestBid) / currentBestBid
askGap = (myBestAsk − currentBestAsk) / currentBestAsk
isDeepInQueue = bidGap > REQUOTE_QUEUE_DEPTH_BPS OR askGap > REQUOTE_QUEUE_DEPTH_BPS
```

`REQUOTE_QUEUE_DEPTH_BPS=0` (disabled by default). Set ví dụ `0.0003` (3 bps) để re-quote khi slipped.

### v5.5 — Inventory-coupled Dynamic Sizing

Thêm hệ số suy giảm theo skew:

```
invCouplingMult = (1 − |ratio|)^DYN_SIZE_INV_COUPLING
effectiveSize   = BASE_SIZE × volSizeMult × invCouplingMult
```

`DYN_SIZE_INV_COUPLING=0` (disabled). α=1 = linear (size=0 tại ratio=1). α=2 = quadratic (mượt hơn).

### v5.6 — Alpha Decay Metric (edgeRealized)

Đo lường edge thực sự per unit notional:

```
tradedNotional += fillPrice × fillQty    [mỗi fill]
edgeRealized   = realizedPnl / tradedNotional
```

Edge bình thường: ~0.0006 (6bps net sau fee). Nếu `edgeRealized` giảm dần theo thời gian → alpha decay → market đang adapt.

### v5.7 — Smart Kill-Switch

Hai điều kiện độc lập (bất kỳ điều kiện nào cũng trigger shutdown):

```
Condition 1: vol > SMART_KILL_VOL_THRESHOLD AND effectiveSpread < vol × 1.5
             → Volatility spike không có edge → shutdown

Condition 2: quotesPlaced ≥ SMART_KILL_MIN_QUOTES
             AND fillRate < SMART_KILL_FILL_RATE_MIN
             → Fill-rate collapse → market moved away → shutdown
```

Disabled by default (`SMART_KILL_ENABLED=false`). Bật khi muốn bảo vệ khỏi market regime changes đột ngột.
---

## P&L: Cách tính đúng với BingX

```
Opening:         profit = −fee × fillPrice × qty
Closing long:    profit = (fillPrice − avgCost) × qty − fee×avgCost×qty − fee×fillPrice×qty
Closing short:   profit = (avgCost − fillPrice) × qty − fee×avgCost×qty − fee×fillPrice×qty
```

Khớp với "Lãi Lỗ đã thực hiện" trên BingX. `avgCost` = VWAP entry price.

**Điều kiện có lãi** (không tính inventory risk):
```
BASE_SPREAD − 2×FEE > 0
0.0018 − 2×0.0003 = 0.0012  (12 bps net edge per round-trip)
```

---

## Cấu hình hiện tại (mainnet swap)

```env
# Exchange
EXCHANGE=bingx
TESTNET=false
MARKET_TYPE=swap
SYMBOL=BTC/USDT:USDT
POSITION_MODE=oneway          # oneway = positionSide BOTH (mặc định BingX)

# Spread
FEE=0.0003                    # 0.03% maker fee
BASE_SPREAD=0.0018            # 18bps gross → 12bps net sau 2×FEE

# Quoting
QUOTE_LEVELS=2                # 2 cặp bid/ask

# Inventory
BASE_SIZE=0.001               # 0.001 BTC/lệnh
SOFT_MAX=0.002                # ~$142 tại $71k
HARD_MAX=0.005                # Trigger T3 hedge + spread widening
INVENTORY_DECAY_GAMMA=0.15    # AS reservation price — kéo fair price về mid
MIN_ORDER_SIZE=0.0001         # BingX minimum contract — clamp khi inv+dynsize thu nhỏ

# Loop & Requote Guard (anti-ban)
LOOP_INTERVAL_MS=5000         # Cycle 5s
FILL_POLL_MS=3000             # Poll fill mỗi 3s
ORDER_TTL_MS=30000            # Carry lệnh 30s trước khi xem xét cancel
MAX_ORDER_AGE_MS=180000       # Force requote sau 3 phút
REQUOTE_PRICE_THRESHOLD=0.0005 # 5bps drift mới cancel
MIN_CANCEL_INTERVAL_MS=45000  # Cooldown 45s giữa cancel
MAX_CANCEL_PER_MIN=4          # Hard cap — tránh ban 109400

# Regime Filter
REGIME_FILTER_ENABLED=true
REGIME_FILTER_MAX_MOVE=0.008  # Pause nếu BTC di chuyển >0.8%/phút
REGIME_FILTER_PAUSE_MS=30000  # Pause 30s

# Risk
DAILY_LOSS_LIMIT=5            # Dừng nếu lỗ $5/ngày
CONSECUTIVE_LOSS=10           # Dừng nếu 10 closing fills lỗ liên tiếp

# v4 Features
FLOW_ENABLED=true
FLOW_KAPPA=0.0003
IMBALANCE_ENABLED=true
IMBALANCE_FACTOR=0.004
INV_SPREAD_K=0.0006           # Mở rộng spread theo inventory (v4.1)
DYN_SIZE_ENABLED=true         # Dynamic size ∝ 1/vol (v4.2)
DYN_SIZE_TARGET_VOL=0.001
FUNDING_BIAS_ENABLED=true     # Funding rate bias (v4.3)
FUNDING_BIAS_K=0.5
TOXIC_FLOW_ENABLED=true       # Toxic flow filter (v4.4)
TOXIC_FLOW_SIDE_RATIO=0.82
TOXIC_FLOW_VWAP_THRESHOLD=0.0004
TOXIC_FLOW_PAUSE_MS=3000
```

---

## Quick Start

```bash
npm install        # Cài dependencies
npm test           # 161 tests — phải 100% PASS
npm run test:live  # Kiểm tra giá BTC thật (không đặt lệnh)
npm start          # Khởi động bot
```

---

## Telegram Alerts

| Loại | Khi nào | Nội dung |
|---|---|---|
| 🚨 SHUTDOWN | Circuit breaker kích hoạt | Lý do, PnL, drawdown |
| ⚠️ Ban warning | BingX error 109400 | Pause 11 phút |
| 📊 PnL digest | Mỗi N phút | realizedPnl, hourlyPnl, fills |

**Setup:**
1. `@BotFather` → `/newbot` → copy token
2. `https://api.telegram.org/bot<TOKEN>/getUpdates` → lấy `chat.id`
3. Điền `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` vào `.env`

---

## Config Reference

### Exchange

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `EXCHANGE` | `bingx` | `binance` hoặc `bingx` |
| `TESTNET` | `false` | `true`=tiền giả |
| `MARKET_TYPE` | `swap` | BingX: `spot` hoặc `swap` |
| `SYMBOL` | `BTC/USDT:USDT` | Swap bắt buộc dùng `:USDT` |
| `POSITION_MODE` | `oneway` | `oneway`=BOTH, `hedge`=LONG/SHORT riêng |

### Spread

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `FEE` | `0.0003` | Maker fee per fill — kiểm tra tier BingX |
| `BASE_SPREAD` | `0.0018` | Phải > 2×FEE; net edge = BASE_SPREAD − 2×FEE |
| `VOL_LOOKBACK` | `20` | Số trade price tính vol |
| `VOL_MULTIPLIER` | `3` | Hệ số vol trong spread |
| `INV_SPREAD_K` | `0.0006` | v4: spread widening theo inventory skew |

### Inventory

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `BASE_SIZE` | `0.001` | Kích thước lệnh (BTC) |
| `SOFT_MAX` | `0.002` | Ngưỡng bắt đầu skew mạnh |
| `HARD_MAX` | `0.005` | Ngưỡng trigger T3 hedge |
| `SKEW_FACTOR` | `0.3` | Mức skew tối đa |
| `SKEW_STEEPNESS` | `1.5` | tanh steepness |
| `INVENTORY_DECAY_GAMMA` | `0.15` | AS decay — kéo fair price về mid |
| `MIN_ORDER_SIZE` | `0.0001` | BingX minimum contract — clamp khi size quá nhỏ |

### Regime Filter

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `REGIME_FILTER_ENABLED` | `true` | Bật regime filter |
| `REGIME_FILTER_MAX_MOVE` | `0.008` | Pause nếu BTC di chuyển >0.8%/phút |
| `REGIME_FILTER_PAUSE_MS` | `30000` | Pause 30s |

### Circuit Breaker

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `DAILY_LOSS_LIMIT` | `5` | $-loss/ngày trigger shutdown |
| `CONSECUTIVE_LOSS` | `10` | Closing fills lỗ liên tiếp trigger shutdown |
| `ADVERSE_FILL_RATIO` | `0.7` | Ngưỡng widen spread |

### Loop & Requote Guard

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `LOOP_INTERVAL_MS` | `5000` | Chu kỳ chính (5s) |
| `FILL_POLL_MS` | `3000` | Kiểm tra fill mỗi 3s |
| `ORDER_TTL_MS` | `30000` | TTL trước khi xem xét cancel |
| `MAX_ORDER_AGE_MS` | `180000` | Force requote sau 3 phút |
| `REQUOTE_PRICE_THRESHOLD` | `0.0005` | Min drift để requote (5 bps) |
| `MIN_CANCEL_INTERVAL_MS` | `45000` | Cooldown 45s giữa 2 lần cancel |
| `MAX_CANCEL_PER_MIN` | `4` | Hard cap cancel/phút (chống ban 109400) |

### v4 Features

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `FLOW_ENABLED` | `true` | Flow signal (EMA last trades) trong fairPrice |
| `FLOW_KAPPA` | `0.0003` | Hệ số flow adjustment |
| `IMBALANCE_ENABLED` | `true` | Orderbook imbalance → spread widening |
| `IMBALANCE_FACTOR` | `0.004` | Hệ số imbalance spread |
| `DYN_SIZE_ENABLED` | `true` | Dynamic size ∝ 1/vol |
| `DYN_SIZE_TARGET_VOL` | `0.001` | Target vol cho sizing |
| `FUNDING_BIAS_ENABLED` | `true` | Funding rate bias trong fairPrice |
| `FUNDING_BIAS_K` | `0.5` | Hệ số funding adjustment |
| `TOXIC_FLOW_ENABLED` | `true` | Toxic flow filter |
| `TOXIC_FLOW_SIDE_RATIO` | `0.82` | Ngưỡng tỷ lệ cùng chiều để detect toxic |
| `TOXIC_FLOW_VWAP_THRESHOLD` | `0.0004` | VWAP deviation ngưỡng (4bps) |
| `TOXIC_FLOW_PAUSE_MS` | `3000` | Pause khi detect toxic flow |

### v5 Features

| Biến | Mặc định | Giải thích |
|---|---|---|
| `DYN_SIZE_INV_COUPLING` | `0` | α cho inventory coupling: (1−\|ratio\|)^α. 0=off, 1=linear, 2=quadratic |
| `REQUOTE_QUEUE_DEPTH_BPS` | `0` | Force requote nếu best order slipped > N bps from best bid/ask. 0=off |
| `SMART_KILL_ENABLED` | `false` | Bật smart kill-switch |
| `SMART_KILL_VOL_THRESHOLD` | `0.008` | Vol spike ngưỡng (80 bps/tick) |
| `SMART_KILL_FILL_RATE_MIN` | `0.001` | Fill rate tối thiểu sau warmup |
| `SMART_KILL_MIN_QUOTES` | `200` | Quotes warmup trước khi check fill rate |

---

## Hướng dẫn Exchange

### BingX Swap Mainnet (đang dùng)

- API: Avatar → API Management → **Trade** permission (không cần Withdraw)
- Symbol: `BTC/USDT:USDT` (format perpetual bắt buộc)
- Min contract: **0.001 BTC**
- Position mode: **One-way** (mặc định) → `POSITION_MODE=oneway`
- Hedge mode (tùy chọn): Account Settings → Position Mode → Hedge → `POSITION_MODE=hedge`
- Cancel-rate limit: BingX ban (error 109400) nếu cancel >99% trong 10 phút. Bot tự pause 15 phút khi bị ban.

### BingX Swap Testnet

- Key: API Management → **Simulation Trading** tab
- `TESTNET=true`, giá BTC thật, lệnh không thật

### Binance Spot Testnet

- `EXCHANGE=binance`, `TESTNET=true`, `FEE=0.001`
- Key: https://testnet.binance.vision/key/generate

---

## Công thức spread & skew

### Spread (6 lớp)

```
vol  = stddev(last_N prices) / mid
imb  = (bidVol − askVol) / (bidVol + askVol)

L1:  spread = max(2×fee, BASE_SPREAD × (1 + VOL_MULT × vol))
L2:  spread = max(spread, IMBALANCE_FACTOR × |imb|)          [nếu bật]
L3:  spread ×= regimeMultiplier                               [ranging=1×, volatile=2×]
L4:  spread ×= (1 + adverseFillRatio)                         [adaptive]
L5:  spread ×= clamp(1 + λ×(fillRate−target), min, max)      [nếu bật]
L6:  spread += INV_SPREAD_K × |ratio|                         [v4: inventory widening]
     spread  = min(spread, SPREAD_MAX_FRACTION)
```

### Fair price (v3 + v4 + v5)

```
microprice = (bid × askVol + ask × bidVol) / (bidVol + askVol)
flowAdj    = FLOW_KAPPA × flowEMA × mid              [FLOW_ENABLED=true]
γ_eff      = GAMMA × (1 + |ratio|)                   [v5: adaptive AS decay]
invDecay   = −γ_eff × ratio × vol × mid

volatile:   fairPrice = microprice + invDecay
tending:    fairPrice = microprice + 1.5×flowAdj + invDecay
ranging:    fairPrice = microprice + 0.5×flowAdj + invDecay

fundingBias applied via inventory target shift (not price), see fundingTargetInv.
```

### Asymmetric skew + tanh

```
half     = spread × mid / 2
skewAbs  = tanh(|ratio| × SKEW_STEEPNESS) × half × SKEW_FACTOR
sign     = +1 khi long, −1 khi short

bid[Lv] = fairPrice − half × mult[Lv] − sign × skewAbs
ask[Lv] = fairPrice + half × mult[Lv] + sign × skewAbs
```

### Dynamic size (v4 + v5)

```
vol             = spread_normalized_vol(mid)
volSizeMult     = clamp(DYN_SIZE_TARGET_VOL / vol, 0.5, 2.0)
invCouplingMult = (1 − |ratio|)^DYN_SIZE_INV_COUPLING  [v5: 0=disabled]
effectiveQty    = BASE_SIZE × volSizeMult × invCouplingMult × levelFraction
```

---

## Tests

```bash
npm test           # 161 tests · 8 suites (không cần API key)
npm run test:unit  # chỉ unit tests
npm run test:live  # giá BTC thật từ BingX
```

| Suite | Tests |
|---|---|
| SpreadEngine | 31 |
| QuoteEngine | 29 |
| InventoryManager | 20 |
| CircuitBreaker | 18 |
| RegimeDetector | 15 |
| MetricsCollector | 10 |
| TelegramAlert | 8 |
| MarketMaker (integration) | 30 |

---

## Logs & Monitoring

| Message | Level | Ý nghĩa |
|---|---|---|
| `MarketMaker v4 starting` | info | Bot khởi động; `fillDetection: websocket+poll` hoặc `poll` |
| `WebSocket order stream started` | info | BingX WS private stream online |
| `Startup: synced existing position` | info | Đồng bộ position + avgCost sau restart |
| `Quotes placed` | info | fairPrice, spread, regime, invRatio |
| `Fill processed` | info | `source: websocket` (<100ms) hoặc `source: poll`; profit, avgCost, isAdverse |
| `Metrics` | info | realizedPnl, hourlyPnl, drawdown, adverseRatio, **edgeRealized** |
| `Intra-cycle gap detected` | warn | \|mid−prevMid\| > 0.3% → cancel + pause |
| `Regime filter triggered` | warn | Giá đột biến → pause |
| `Toxic flow detected` | warn | Pause 3s, bỏ qua cycle |
| `T3 hard limit triggered` | warn | Inventory vượt hardMax → hedge |
| `Adverse fill ratio high` | warn | Spread tự mở rộng |
| `WebSocket order stream terminated` | warn | WS lỗi → fallback REST polling tự động |
| `BingX cancel-rate ban detected` | warn | Error 109400 → pause **15 phút** |
| `SHUTDOWN triggered` | error | Circuit breaker |

### Key metrics

| Metric | Ý nghĩa |
|---|---|
| `realizedPnl` | Cumulative P&L cost-basis (khớp BingX "Lãi Lỗ đã thực hiện") |
| `hourlyPnl` | P&L 1 giờ gần nhất |
| `adverseFillRatio` | Tỷ lệ fill xấu: sell dưới mid / buy trên mid (rolling 20 fills) |
| `invRatio` | inventory / softMax — dương=long, âm=short |
| `avgCost` | Giá mở vị thế VWAP |
| `fillRate` | fills / quotesPlaced |

---

## Safety Checklist

Trước khi chạy mainnet tiền thật:

- [ ] `npm test` → **158 PASS** (0 failed)
- [ ] `npm run test:live` → thấy giá BTC trong log
- [ ] `FEE` khớp đúng fee tier BingX; `BASE_SPREAD` > `2×FEE`
- [ ] `POSITION_MODE` khớp với Account Settings → Position Mode trên BingX
- [ ] `DAILY_LOSS_LIMIT` ≤ 10% tổng vốn
- [ ] `HARD_MAX × giá_BTC` ≤ margin available
- [ ] `REGIME_FILTER_ENABLED=true`; `REGIME_FILTER_MAX_MOVE` ≤ 0.01 (1%)
- [ ] Telegram alert test — nhận được tin nhắn shutdown
- [ ] API key: chỉ **Trade**, không có **Withdraw**
- [ ] IP whitelist nếu chạy VPS
- [ ] Theo dõi `invRatio` trong 30 phút đầu — không được tích lũy vượt 0.8
- [ ] Không thấy "No position to close" sau 10 phút đầu — nếu thấy → kiểm tra POSITION_MODE
- [ ] Không thấy "amount must be greater than minimum" — nếu thấy → tăng BASE_SIZE hoặc giảm SIZE_FACTOR

---

## License

MIT
