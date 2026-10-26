"""
SignalCompare: dry-run only strategy whose rules mirror the TypeScript signal bot,
so the two bots can be compared on the same candles.

Rules (long only, BTC/USDT, 1h):
  entry : RSI(14) crosses above 30 on a CLOSED candle, volume > 0
  SL    : entry - 1.5 * ATR(14) of the signal candle
  TP    : entry + 3.0 * ATR(14) of the signal candle
  tag   : confidence High / Medium / Low (RSI cross + close above EMA50 + volume)
"""

from datetime import timedelta

import talib.abstract as ta
from pandas import DataFrame

from freqtrade.exchange import timeframe_to_minutes, timeframe_to_prev_date
from freqtrade.persistence import Trade
from freqtrade.strategy import IStrategy, stoploss_from_absolute


class SignalCompare(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "1h"
    can_short = False

    # Hard safety net only. The real SL/TP are ATR based (see callbacks below).
    stoploss = -0.10
    minimal_roi = {"0": 100}  # disabled, TP handled in custom_exit
    use_custom_stoploss = True
    process_only_new_candles = True
    startup_candle_count = 60

    ATR_SL_MULT = 1.5
    ATR_TP_MULT = 3.0

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["ema50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        crossed = (dataframe["rsi"].shift(1) < 30) & (dataframe["rsi"] >= 30)
        volume_ok = dataframe["volume"] > 0
        trend_ok = dataframe["close"] > dataframe["ema50"]

        score = crossed.astype(int) + trend_ok.astype(int) + volume_ok.astype(int)

        dataframe.loc[crossed & volume_ok, "enter_long"] = 1
        dataframe.loc[crossed & volume_ok, "enter_tag"] = score.map(
            {3: "High", 2: "Medium", 1: "Low"}
        )
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # No indicator exit: trades close only by ATR stop or ATR take-profit.
        return dataframe

    # --- helpers -----------------------------------------------------------
    def _signal_atr(self, pair: str, trade: Trade) -> float | None:
        """ATR of the candle that produced the signal (the one before entry).

        Saved on the trade the first time, so SL/TP keep working after the signal
        candle has scrolled out of the analyzed dataframe (long-running trades).
        """
        cached = trade.get_custom_data("signal_atr")
        if cached is not None:
            return float(cached)
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        entry_candle = timeframe_to_prev_date(self.timeframe, trade.open_date_utc)
        signal_candle = entry_candle - timedelta(minutes=timeframe_to_minutes(self.timeframe))
        row = dataframe.loc[dataframe["date"] == signal_candle]
        if row.empty:
            return None
        atr = float(row.iloc[0]["atr"])
        trade.set_custom_data("signal_atr", atr)
        return atr

    # --- ATR stop loss / take profit --------------------------------------
    def custom_stoploss(
        self,
        pair: str,
        trade: Trade,
        current_time,
        current_rate: float,
        current_profit: float,
        after_fill: bool,
        **kwargs,
    ) -> float | None:
        atr = self._signal_atr(pair, trade)
        if atr is None:
            return None
        stop_price = trade.open_rate - self.ATR_SL_MULT * atr
        return stoploss_from_absolute(
            stop_price, current_rate=current_rate, is_short=False, leverage=trade.leverage
        )

    def custom_exit(
        self,
        pair: str,
        trade: Trade,
        current_time,
        current_rate: float,
        current_profit: float,
        **kwargs,
    ) -> str | bool | None:
        atr = self._signal_atr(pair, trade)
        if atr is None:
            return None
        if current_rate >= trade.open_rate + self.ATR_TP_MULT * atr:
            return "tp_atr"
        return None
