# Crypto signal bot (paper testing only)

Generates BUY/SELL signals for BTC/USDT 15m, saves them to Supabase and marks each one win/loss.
**No trading, no exchange API keys, no orders.** Binance is used only for public price data.

Strategy (`bot/src/strategy.ts`, shared by live bot and backtest):
- BUY when EMA 9 crosses above EMA 21 and RSI(14) < 70
- SELL when EMA 9 crosses below EMA 21 and RSI(14) > 30
- Entry = close of the signal candle, SL = 1.5 × ATR(14), TP = 3 × ATR(14)
- Signals only on closed candles. If SL and TP are both hit inside one candle, it counts as a loss.

## Setup

1. Create a Supabase project. In the SQL editor run `supabase/schema.sql`.
2. Bot:
   ```bash
   cd bot
   npm install
   cp .env.example .env      # fill SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
   npm test                  # strategy self-check
   npm run backtest          # 6 months of history, no Supabase needed
   npm start                 # live bot, keep it running
   ```
3. Dashboard:
   ```bash
   cd web
   npm install
   cp .env.example .env.local   # fill SUPABASE_URL + SUPABASE_ANON_KEY
   npm run dev                  # http://localhost:3000
   ```
   Deploy to Vercel: set the same two env vars there.

## Telegram alerts (optional)

The bot messages you when a signal is created and when it closes as win/loss.

1. In Telegram open **@BotFather** → `/newbot` → pick a name and a username ending in `bot`. It replies with a token like `123456789:AA...`.
2. Put it in `bot/.env` as `TELEGRAM_BOT_TOKEN=...`.
3. Open your new bot in Telegram and press **Start** (or send it any message).
4. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `"chat":{"id":...}` into `TELEGRAM_CHAT_ID=...`.
5. Restart the bot (`npm start`).

## How it works

- `bot/src/index.ts` loads 500 candles over REST, then listens to the Binance kline WebSocket. When a 15m candle closes it runs the strategy; a signal on that candle is inserted (duplicate candles are ignored by a unique constraint). It reconnects after 5s if the socket drops and reloads history on every reconnect.
- Every minute it writes a heartbeat and checks open signals against 1m candles since entry, so wicks between checks are not missed.
- `bot/src/tune.ts` (`npm run tune`, `TIMEFRAME=4h npm run tune`) tries cross / pullback / breakout / Bollinger with a small settings grid, picks the best on the last 12 months and reports how that pick did on the 12 months before (never used for picking).
- `bot/src/backtest.ts` runs one strategy on history (`STRATEGY`, `PARAM`, `TIMEFRAME`, `TREND_EMA`, `SL_ATR`, `TP_ATR` env vars; defaults = live bot rules) and prints signals, win rate, avg win/loss, total return and max drawdown, after 0.1% fee + 0.05% slippage per side.

The bot must run on a machine that stays on (your PC, a VPS, Railway/Render worker). Vercel only hosts the dashboard.
