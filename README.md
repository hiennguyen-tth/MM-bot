# MM Bot v3 — Production Market-Making Bot

Market-making bot production-grade: 4 lớp risk pipeline, multi-level quoting, **microprice + flow signal + inventory decay (AS reservation price)**, nonlinear tanh skew, fill-rate adaptive spread. Hỗ trợ Binance và BingX (spot + swap perpetual).

**Nguyên tắc cốt lõi**: Bot đặt lệnh hai chiều (bid/ask) liên tục, kiếm lợi nhuận từ spread. Mỗi giao dịch lãi nhỏ nhưng tần suất cao. Risk được kiểm soát bằng inventory skew, regime filter và circuit breaker.

---

## Mục lục

1. [Tổng quan kiến trúc](#tổng-quan-kiến-trúc)
2. [Vòng lặp giao dịch](#vòng-lặp-giao-dịch)
3. [Pipeline rủi ro 4 lớp](#pipeline-rủi-ro-4-lớp)
4. [Tính năng v2 + v3](#tính-năng-v2--v3)
5. [Cấu hình hiện tại (mainnet swap)](#cấu-hình-hiện-tại-mainnet-swap)
6. [Quick Start](#quick-start)
7. [Telegram Alerts](#telegram-alerts)
8. [Config Reference](#config-reference)
9. [Hướng dẫn Exchange](#hướng-dẫn-exchange)
10. [Công thức spread & skew](#công-thức-spread--skew)
11. [P&L: Cách tính đúng với BingX](#pl-cách-tính-đúng-với-bingx)
12. [Tests](#tests)
13. [Logs & Monitoring](#logs--monitoring)
14. [Safety Checklist](#safety-checklist)

---

## Tổng quan kiến trúc

```
┌──────────────────────────────────────────────────────────────┐
│                         MarketMaker                          │
│                                                              │
│  ┌─────────────────┐  ┌───────────────────┐  ┌───────────┐  │
│  │  RegimeDetector  │  │   SpreadEngine    │  │QuoteEngine│  │
│  │ ranging/trend/   │  │ vol→imb→regime→   │  │ N-level   │  │
│  │ volatile/unknown │  │ adverse→fillrate  │  │ tanh skew │  │
│  └─────────────────┘  └───────────────────┘  └───────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │    InventoryManager (avg-cost tracking, VaR-aware)   │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │       CircuitBreaker  ←→  TelegramAlert              │    │
│  └──────────────────────────────────────────────────────┘    │
│                           │                                  │
│              ExchangeFactory.createExchange()                │
│          ┌────────────────┴──────────────────┐               │
│   BinanceAdapter                   BingXAdapter              │
│   (spot)                   (spot + swap/perpetual)           │
└──────────────────────────────────────────────────────────────┘
```

| Module | Vai trò |
|---|---|
| `MarketMaker` | Orchestrator vòng lặp chính |
| `RegimeDetector` | Phân loại thị trường: ranging / trending_up / trending_down / volatile |
| `SpreadEngine` | 5 lớp spread: vol → imbalance → regime → adverse fill → fill-rate |
| `QuoteEngine` | Tạo N cặp bid/ask với asymmetric tanh-skew centered on fairPrice |
| `InventoryManager` | Giới hạn vị thế, weighted avg cost, VaR cap |
| `CircuitBreaker` | T4: daily loss / consecutive loss → shutdown |
| `TelegramAlert` | Push Telegram khi shutdown + báo cáo PnL định kỳ |
| `MetricsCollector` | Fill rate, PnL thực, drawdown, adverse ratio |

---

## Vòng lặp giao dịch

```
Mỗi cycle (LOOP_INTERVAL_MS=30000ms):

  B1: T4 CircuitBreaker.check()
      dailyLoss > DAILY_LOSS_LIMIT? → SHUTDOWN + Telegram
      consecutiveLoss > CONSECUTIVE_LOSS? → SHUTDOWN + Telegram
      (chỉ đếm closing fills — opening fee không kích hoạt consecutive)

  B2: getOrderBook() + getRecentTrades() song song
      microprice = (bid×askVol + ask×bidVol) / (bidVol+askVol)

  B3: Regime filter
      move_1m = |mid_now − mid_60s_ago| / mid_60s_ago
      > 0.8%? → cancel tất cả → pause 30s

  B4: SpreadEngine.compute(mid, regime, imbalance)
      L1: BASE_SPREAD × (1 + VOL_MULT × stddev/mid)
      L2: imbalance spread
      L3: regime multiplier (ranging=1×, volatile=2×)
      L4: adverse fill multiplier (1 + adverseRatio)
      L5: fill-rate feedback

  B5: VaR limit + T3 HEDGE nếu |inventory| > effectiveHardMax
      → limit order tại mid±fee → poll 2s → market fallback

  B6: T2 Skew + fairPrice
      ratio = clamp(inventory / softMax, -1, 1)
      fairPrice = microprice + flowAdj + invDecay

  B7: Requote guard (chống BingX cancel-rate ban)
      Inventory sign đổi? → bắt buộc requote
      Giá/spread ổn, lệnh còn trẻ? → carry forward
      Cancel cooldown / rate cap? → hold

  B8: Cancel lệnh cũ → Place lệnh mới
      positionSide = LONG/SHORT theo inventory (BingX Hedge Mode)

  B9: Poll fills mỗi 5s trong 60s TTL
      Fill → tính P&L cost-basis → cập nhật inventory + metrics
      Latency: drift > 0.2%? → cancel tất cả

  B10: Carry-forward nếu lệnh còn trẻ (<3 phút)
       Cập nhật adverseMultiplier + push Telegram
       Sleep(30s) → quay B1
```

---

## Pipeline rủi ro 4 lớp

```
         Fill xảy ra
              │
      ┌───────▼───────┐
 T4   │ CircuitBreaker│  dailyLoss > LIMIT?        → SHUTDOWN + Telegram
      │               │  consecutiveLoss > LIMIT?  → SHUTDOWN + Telegram
      └───────┬───────┘  (closing fills only)
              │
      ┌───────▼───────┐
 T3   │    Hedger     │  |inventory| > effectiveHardMax?
      │  limit-first  │  → Limit tại mid±fee → timeout → Market fallback
      └───────┬───────┘
              │
      ┌───────▼───────┐
 T2   │ InventoryMgr  │  Asymmetric tanh-skew + size reduction
      │  (VaR-aware)  │  effectiveHardMax = min(HARD_MAX, capital/(vol×varMult))
      └───────┬───────┘
              │
      ┌───────▼───────┐
 T1   │ SpreadEngine  │  adverseMultiplier = 1 + adverseFillRatio (adaptive)
      │  (adaptive)   │  Spread tự mở/thu theo fill quality
      └───────────────┘
```

---

## Tính năng v2 + v3

### Orderbook Imbalance Spread

```
imbalance = (bidVolume - askVolume) / (bidVolume + askVolume)
spread    = max(vol_spread, IMBALANCE_FACTOR × |imbalance|)
```

Tắt mặc định (`IMBALANCE_ENABLED=false`) để giảm requote frequency.

### Asymmetric Inventory Skew

```
Long (muốn sell):   bid thấp xuống, ask lên cao  → inventory tự giảm
Short (muốn buy):   bid lên cao,   ask thấp xuống → inventory tự tăng
```

Sử dụng tanh để bão hòa khi ratio gần max — tránh spread cực đoan khi cần fill nhất.

### Multi-level Quoting

```
L1: spread × 1.0  ×  50% size   ← tight, fill rate cao nhất
L2: spread × 1.5  ×  30% size
L3: spread × 2.0  ×  20% size   ← wide, passive insurance
```

### Regime Filter

Pause quoting khi BTC di chuyển > 0.8% trong 1 phút. Bảo vệ khỏi downtrend tích lũy inventory thua lỗ. (Cũ: 1.5% — quá rộng, bot vẫn mua vào khi giá giảm 1%.)

### Requote Guard

Chỉ cancel+replace khi:
- Inventory sign đổi chiều (positionSide cũ sẽ gây "No position to close")
- Giá drift > 2 bps
- Lệnh cũ hơn 3 phút

### BingX Hedge Mode (Two-sided positionSide)

```
inventory >= 0 → buy=LONG,  sell=LONG  (mở/đóng long)
inventory <  0 → buy=SHORT, sell=SHORT (đóng/mở short)
inventory == 0 → buy=LONG,  sell=SHORT (mở cả hai phía)
```

### v3.1 Microprice, v3.2 Flow Signal, v3.3 Fill-rate Feedback, v3.4 tanh Skew, v3.5 Inventory Decay

Xem công thức tại phần [Công thức spread & skew](#công-thức-spread--skew).

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
0.001 − 2×0.0003 = 0.0004 (4 bps gross edge per round-trip)
```

---

## Cấu hình hiện tại (mainnet swap)

```env
# Exchange
EXCHANGE=bingx
TESTNET=false
MARKET_TYPE=swap
SYMBOL=BTC/USDT:USDT

# Spread
FEE=0.0003              # 0.03% maker fee (kiểm tra tier BingX)
BASE_SPREAD=0.001       # 0.1% spread → gross edge = 0.04% sau phí 2 chiều

# Quoting
QUOTE_LEVELS=1          # 1 cặp bid/ask (tăng lên 3 khi prod)

# Inventory
BASE_SIZE=0.001         # 0.001 BTC/lệnh (min contract BingX swap)
SOFT_MAX=0.002          # ~$142 tại $71k
HARD_MAX=0.003          # ~$213 — trigger T3 hedge

# Risk
REGIME_FILTER_MAX_MOVE=0.008    # Pause nếu BTC di chuyển >0.8%/phút
DAILY_LOSS_LIMIT=5              # Dừng nếu lỗ $5/ngày (closing fills)
CONSECUTIVE_LOSS=10             # Dừng nếu 10 closing fills lỗ liên tiếp

# Loop
ORDER_TTL_MS=60000              # Carry orders 60s
MAX_ORDER_AGE_MS=180000         # Force requote sau 3 phút

# Tắt các feature trigger requote
FLOW_ENABLED=false
IMBALANCE_ENABLED=false
ADAPTIVE_TIMING_ENABLED=false
```

---

## Quick Start

```bash
npm install        # Cài dependencies
npm test           # 158 tests — phải 100% PASS
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

### Spread

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `FEE` | `0.0003` | Maker fee per fill — kiểm tra tier BingX |
| `BASE_SPREAD` | `0.001` | Phải > 2×FEE |
| `VOL_LOOKBACK` | `20` | Số trade price tính vol |
| `VOL_MULTIPLIER` | `3` | Hệ số vol trong spread |

### Inventory

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `BASE_SIZE` | `0.001` | Kích thước lệnh (BTC) |
| `SOFT_MAX` | `0.002` | Ngưỡng bắt đầu skew mạnh |
| `HARD_MAX` | `0.003` | Ngưỡng trigger T3 hedge |
| `SKEW_FACTOR` | `0.3` | Mức skew tối đa |
| `SKEW_STEEPNESS` | `1.5` | tanh steepness |
| `INVENTORY_DECAY_GAMMA` | `0` | AS decay (0=tắt) |

### Regime Filter

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `REGIME_FILTER_ENABLED` | `true` | Bật regime filter |
| `REGIME_FILTER_MAX_MOVE` | `0.008` | Pause nếu BTC di chuyển >0.8%/phút |
| `REGIME_FILTER_PAUSE_MS` | `30000` | Pause 30s |

### Circuit Breaker

| Biến | Hiện tại | Prod | Giải thích |
|---|---|---|---|
| `DAILY_LOSS_LIMIT` | `5` | ≤10% vốn | $-loss/ngày |
| `CONSECUTIVE_LOSS` | `10` | `5` | Closing fills lỗ liên tiếp |
| `ADVERSE_FILL_RATIO` | `0.7` | `0.6` | Ngưỡng widen spread |

### Loop & Requote Guard

| Biến | Hiện tại | Giải thích |
|---|---|---|
| `LOOP_INTERVAL_MS` | `30000` | Chu kỳ chính (30s) |
| `FILL_POLL_MS` | `5000` | Kiểm tra fill mỗi 5s |
| `ORDER_TTL_MS` | `60000` | TTL trước khi xem xét cancel |
| `MAX_ORDER_AGE_MS` | `180000` | Force requote sau 3 phút |
| `REQUOTE_PRICE_THRESHOLD` | `0.0002` | Min drift để requote (2 bps) |
| `MIN_CANCEL_INTERVAL_MS` | `10000` | Cooldown giữa 2 lần cancel |
| `MAX_CANCEL_PER_MIN` | `10` | Hard cap cancel/phút |

---

## Hướng dẫn Exchange

### BingX Swap Mainnet (đang dùng)

- API: Avatar → API Management → **Trade** permission (không cần Withdraw)
- Symbol: `BTC/USDT:USDT` (format perpetual bắt buộc)
- Min contract: **0.001 BTC**
- Hedge Mode: bot tự set positionSide

### BingX Swap Testnet

- Key: API Management → **Simulation Trading** tab
- `TESTNET=true`, giá BTC thật, lệnh không thật

### Binance Spot Testnet

- `EXCHANGE=binance`, `TESTNET=true`, `FEE=0.001`
- Key: https://testnet.binance.vision/key/generate

---

## Công thức spread & skew

### Spread (5 lớp)

```
vol  = stddev(last_N prices) / mid
imb  = (bidVol − askVol) / (bidVol + askVol)

L1:  spread = max(2×fee, BASE_SPREAD × (1 + VOL_MULT × vol))
L2:  spread = max(spread, IMBALANCE_FACTOR × |imb|)          [nếu bật]
L3:  spread ×= regimeMultiplier                               [ranging=1×, volatile=2×]
L4:  spread ×= (1 + adverseFillRatio)                         [adaptive]
L5:  spread ×= clamp(1 + λ×(fillRate−target), min, max)      [nếu bật]
     spread  = min(spread, SPREAD_MAX_FRACTION)
```

### Fair price (v3)

```
microprice = (bid × askVol + ask × bidVol) / (bidVol + askVol)
flowAdj    = FLOW_KAPPA × flowEMA × mid          [nếu FLOW_ENABLED=true]
invDecay   = −GAMMA × ratio × vol × mid          [nếu GAMMA > 0]
fairPrice  = microprice + flowAdj + invDecay
```

### Asymmetric skew + tanh

```
half     = spread × mid / 2
skewAbs  = tanh(|ratio| × SKEW_STEEPNESS) × half × SKEW_FACTOR
sign     = +1 khi long, −1 khi short

bid[Lv] = fairPrice − half × mult[Lv] − sign × skewAbs
ask[Lv] = fairPrice + half × mult[Lv] + sign × skewAbs
```

---

## Tests

```bash
npm test           # 158 tests · 8 suites (không cần API key)
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
| MarketMaker (integration) | 27 |

---

## Logs & Monitoring

| Message | Level | Ý nghĩa |
|---|---|---|
| `MarketMaker v3 starting` | info | Bot khởi động |
| `Startup: synced existing position` | info | Đồng bộ position + avgCost sau restart |
| `Quotes placed` | info | fairPrice, spread, regime, invRatio |
| `Fill processed` | info | profit (cost-basis), avgCost, isAdverse, inventory |
| `Metrics` | info | realizedPnl, hourlyPnl, drawdown, adverseRatio |
| `Regime filter triggered` | warn | Giá đột biến → pause |
| `T3 hard limit triggered` | warn | Inventory vượt hardMax → hedge |
| `Adverse fill ratio high` | warn | Spread tự mở rộng |
| `BingX cancel-rate ban detected` | warn | Error 109400 → pause 11 phút |
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
- [ ] `DAILY_LOSS_LIMIT` ≤ 10% tổng vốn
- [ ] `HARD_MAX × giá_BTC` ≤ margin available
- [ ] `REGIME_FILTER_ENABLED=true`; `REGIME_FILTER_MAX_MOVE` ≤ 0.01 (1%)
- [ ] Telegram alert test — nhận được tin nhắn shutdown
- [ ] API key: chỉ **Trade**, không có **Withdraw**
- [ ] IP whitelist nếu chạy VPS
- [ ] Theo dõi `invRatio` trong 30 phút đầu — không được tích lũy vượt 0.8

---

## License

MIT
