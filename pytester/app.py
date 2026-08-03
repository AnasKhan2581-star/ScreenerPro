"""ScreenerPro desktop tester — Tkinter GUI.

Run:  python -m pytester.app     (from the repo root)

Stdlib Tkinter + matplotlib only: no extra installs. Three tabs — Backtest (stats, equity
curve, trades), Sweep (parameter grid with fold survival), Folds (regime stability).
"""
from __future__ import annotations

import queue
import threading
import tkinter as tk
from itertools import product
from tkinter import ttk

import matplotlib
matplotlib.use("TkAgg")
import numpy as np                                                  # noqa: E402
import pandas as pd                                                 # noqa: E402
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg     # noqa: E402
from matplotlib.figure import Figure                                # noqa: E402

from . import data, engine, strategies                              # noqa: E402

BG, FG, PANEL, MUTED = "#0e1117", "#d4d8df", "#161b22", "#8b949e"
GREEN, RED, BLUE = "#3fb950", "#f85149", "#58a6ff"
SYMBOLS = ["ZECUSDT", "BTCUSDT", "SOLUSDT", "XRPUSDT", "SUIUSDT", "LINKUSDT", "XMRUSDT"]
TFS = ["15m", "30m", "1h", "2h", "4h", "1d", "1w"]


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ScreenerPro — Desktop Strategy Tester")
        self.geometry("1280x860")
        self.configure(bg=BG)
        self.df: pd.DataFrame | None = None
        self.result: engine.Result | None = None
        self.q: queue.Queue = queue.Queue()
        self._style()
        self._controls()
        self._tabs()
        self.after(100, self._drain)

    # ---------------------------------------------------------------- chrome
    def _style(self):
        s = ttk.Style(self)
        s.theme_use("clam")
        s.configure(".", background=BG, foreground=FG, fieldbackground=PANEL,
                    bordercolor="#222a35", lightcolor=PANEL, darkcolor=PANEL)
        s.configure("TNotebook", background=BG, borderwidth=0)
        s.configure("TNotebook.Tab", background=PANEL, foreground=MUTED, padding=(14, 6))
        s.map("TNotebook.Tab", background=[("selected", "#1f6feb")],
              foreground=[("selected", "#fff")])
        s.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=FG,
                    rowheight=22, borderwidth=0)
        s.configure("Treeview.Heading", background="#0d1117", foreground=MUTED)
        s.configure("TButton", background="#1f6feb", foreground="#fff", padding=(10, 4))
        s.map("TButton", background=[("active", "#388bfd")])

    def _controls(self):
        bar = tk.Frame(self, bg=PANEL, pady=8, padx=10)
        bar.pack(fill="x")

        def lab(t):
            tk.Label(bar, text=t, bg=PANEL, fg=MUTED, font=("Segoe UI", 8)).pack(side="left", padx=(10, 2))

        lab("SYMBOL")
        self.sym = ttk.Combobox(bar, values=SYMBOLS, width=11)
        self.sym.set("ZECUSDT"); self.sym.pack(side="left")
        lab("TF")
        self.tf = ttk.Combobox(bar, values=TFS, width=5, state="readonly")
        self.tf.set("15m"); self.tf.pack(side="left")
        lab("BARS  (0 = all history)")
        self.bars = tk.Entry(bar, width=8, bg="#0d1117", fg=FG, insertbackground=FG,
                             relief="flat")
        self.bars.insert(0, "70000"); self.bars.pack(side="left")
        lab("STRATEGY")
        self.strat = ttk.Combobox(bar, width=26, state="readonly",
                                  values=[strategies.REGISTRY[k]["label"] for k in strategies.REGISTRY])
        self.strat.current(0); self.strat.pack(side="left")
        self.strat.bind("<<ComboboxSelected>>", lambda e: self._show_params())
        lab("SIZING")
        self.sizing = ttk.Combobox(bar, width=22, state="readonly",
                                   values=["risk % per trade", "exposure % per hold"])
        self.sizing.current(0); self.sizing.pack(side="left")
        lab("SIZE %")
        self.size = tk.Entry(bar, width=5, bg="#0d1117", fg=FG, insertbackground=FG, relief="flat")
        self.size.insert(0, "1"); self.size.pack(side="left")
        lab("FEE %/side")
        self.fee = tk.Entry(bar, width=5, bg="#0d1117", fg=FG, insertbackground=FG, relief="flat")
        self.fee.insert(0, "0.1"); self.fee.pack(side="left")
        lab("FILL")
        self.fill = ttk.Combobox(bar, width=12, state="readonly",
                                 values=["close (webapp)", "next open (strict)"])
        self.fill.current(0); self.fill.pack(side="left")
        ttk.Button(bar, text="Run  ▶", command=self.run).pack(side="left", padx=12)

        self.pbar = tk.Frame(self, bg=PANEL, pady=4, padx=10)
        self.pbar.pack(fill="x")
        tk.Label(self.pbar, text="PARAMS", bg=PANEL, fg=MUTED,
                 font=("Segoe UI", 8)).pack(side="left", padx=(0, 6))
        self.pentries: dict = {}
        self._show_params()

        self.status = tk.Label(self, text="idle", bg=BG, fg=MUTED, anchor="w", padx=12)
        self.status.pack(fill="x")

    def _key(self) -> str:
        return list(strategies.REGISTRY)[self.strat.current()]

    def _show_params(self):
        for w in list(self.pentries.values()):
            w.master.destroy()
        self.pentries.clear()
        for name, val in strategies.REGISTRY[self._key()]["params"].items():
            f = tk.Frame(self.pbar, bg=PANEL)
            f.pack(side="left", padx=6)
            tk.Label(f, text=name, bg=PANEL, fg=MUTED, font=("Segoe UI", 8)).pack()
            e = tk.Entry(f, width=6, bg="#0d1117", fg=FG, insertbackground=FG, relief="flat",
                         justify="center")
            e.insert(0, str(val)); e.pack()
            self.pentries[name] = e

    def _tabs(self):
        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=8, pady=6)
        self.t_bt, self.t_sw, self.t_fo = (tk.Frame(nb, bg=BG) for _ in range(3))
        nb.add(self.t_bt, text="Backtest"); nb.add(self.t_sw, text="Sweep"); nb.add(self.t_fo, text="Folds")

        self.stats = tk.Label(self.t_bt, text="—", bg=BG, fg=FG, justify="left", anchor="nw",
                              font=("Consolas", 10), padx=10, pady=8)
        self.stats.pack(fill="x")
        self.fig = Figure(figsize=(9, 3.1), facecolor=BG)
        self.ax = self.fig.add_subplot(111, facecolor=PANEL)
        self.canvas = FigureCanvasTkAgg(self.fig, self.t_bt)
        self.canvas.get_tk_widget().pack(fill="x", padx=8)
        cols = ("entry", "buy", "stop", "exit", "why", "move", "R", "bars", "equity")
        self.tree = ttk.Treeview(self.t_bt, columns=cols, show="headings", height=12)
        for c, w in zip(cols, (140, 90, 90, 90, 70, 80, 70, 60, 90)):
            self.tree.heading(c, text=c.upper()); self.tree.column(c, width=w, anchor="e")
        self.tree.pack(fill="both", expand=True, padx=8, pady=6)

        # sweep tab
        top = tk.Frame(self.t_sw, bg=BG); top.pack(fill="x", pady=6, padx=8)
        tk.Label(top, text="grid — one param per line, e.g.   lbStop = 2, 2.5, 3, 4",
                 bg=BG, fg=MUTED).pack(side="left")
        ttk.Button(top, text="Sweep  ▶", command=self.sweep).pack(side="right")
        self.grid_txt = tk.Text(self.t_sw, height=5, bg=PANEL, fg=FG, insertbackground=FG,
                                relief="flat", font=("Consolas", 10))
        self.grid_txt.insert("1.0", "lbBreak = 1, 2, 3\nlbStop = 2, 2.5, 3, 4\nlbExit = 0.5, 1, 2")
        self.grid_txt.pack(fill="x", padx=8)
        scols = ("params", "n", "WR%", "PF", "ret%", "DD%", "/mo", "hold h", "worst fold")
        self.stree = ttk.Treeview(self.t_sw, columns=scols, show="headings", height=20)
        for c, w in zip(scols, (330, 60, 70, 70, 90, 70, 60, 70, 90)):
            self.stree.heading(c, text=c.upper()); self.stree.column(c, width=w, anchor="e")
        self.stree.column("params", anchor="w")
        self.stree.pack(fill="both", expand=True, padx=8, pady=6)

        self.folds_lbl = tk.Label(self.t_fo, text="run a backtest first", bg=BG, fg=FG,
                                  justify="left", anchor="nw", font=("Consolas", 10), padx=10, pady=10)
        self.folds_lbl.pack(fill="both", expand=True)

    # ---------------------------------------------------------------- running
    def _params(self) -> dict:
        out = {}
        for k, e in self.pentries.items():
            try:
                out[k] = float(e.get())
            except ValueError:
                pass
        return out

    def _cfg(self):
        return dict(fee_pct=float(self.fee.get() or 0.1),
                    sizing="risk" if self.sizing.current() == 0 else "exposure",
                    size_pct=float(self.size.get() or 1))

    def run(self):
        threading.Thread(target=self._run_bg, daemon=True).start()

    def _run_bg(self):
        try:
            sym, tf = self.sym.get().upper(), self.tf.get()
            bars = int(self.bars.get() or 0)
            self.q.put(("status", f"fetching {sym} {tf} ..."))
            df = data.load(sym, tf, bars,
                           progress=lambda a, b: self.q.put(("status", f"fetching {a:,}/{b:,} bars")))
            if not len(df):
                self.q.put(("status", "no data")); return
            self.df = df
            key = self._key()
            fill = "close" if self.fill.current() == 0 else "open"
            self.q.put(("status", f"{data.describe(df)} — running {key} ..."))
            trades, used = strategies.run(key, df, self._params(), fill=fill)
            res = engine.evaluate(trades, df, **self._cfg())
            fo = engine.folds(trades, df, 3, **self._cfg())
            qu = engine.quarterly(trades, df, **self._cfg())
            self.result = res
            self.q.put(("done", (res, fo, qu, used, data.describe(df))))
        except Exception as e:                                        # noqa: BLE001
            self.q.put(("status", f"error: {e}"))

    def sweep(self):
        threading.Thread(target=self._sweep_bg, daemon=True).start()

    def _sweep_bg(self):
        try:
            if self.df is None:
                self.q.put(("status", "run a backtest first (loads the data)")); return
            grid: dict = {}
            for line in self.grid_txt.get("1.0", "end").strip().splitlines():
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                grid[k.strip()] = [float(x) for x in v.split(",") if x.strip()]
            if not grid:
                self.q.put(("status", "no grid")); return
            keys = list(grid)
            combos = list(product(*(grid[k] for k in keys)))
            base, key = self._params(), self._key()
            fill = "close" if self.fill.current() == 0 else "open"
            cfg, rows = self._cfg(), []
            for n, combo in enumerate(combos, 1):
                p = dict(base); p.update(dict(zip(keys, combo)))
                trades, _ = strategies.run(key, self.df, p, fill=fill)
                res = engine.evaluate(trades, self.df, **cfg)
                fo = engine.folds(trades, self.df, 3, **cfg)
                rows.append((", ".join(f"{k}={v:g}" for k, v in zip(keys, combo)), res,
                             min(f.expectancy_r for f in fo)))
                if n % 5 == 0 or n == len(combos):
                    self.q.put(("status", f"sweep {n}/{len(combos)}"))
            rows.sort(key=lambda r: r[1].ret_pct, reverse=True)
            self.q.put(("sweep", rows))
        except Exception as e:                                        # noqa: BLE001
            self.q.put(("status", f"sweep error: {e}"))

    # ---------------------------------------------------------------- render
    def _drain(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "status":
                    self.status.config(text=payload)
                elif kind == "done":
                    self._render(*payload)
                elif kind == "sweep":
                    self._render_sweep(payload)
        except queue.Empty:
            pass
        self.after(120, self._drain)

    def _render(self, res, fo, qu, used, desc):
        c = self._cfg()
        mode = "risk %/trade" if c["sizing"] == "risk" else "exposure %/hold"
        self.stats.config(text=(
            f"{desc}   |   {mode} = {c['size_pct']:g}%   fee {c['fee_pct']:g}%/side\n"
            f"trades {res.n:>5}    win rate {res.win_rate:6.1f}%    profit factor "
            f"{res.profit_factor:6.2f}    expectancy {res.expectancy_r:+.3f}R\n"
            f"net     {res.ret_pct:+9.1f}%    max drawdown {res.max_dd:6.1f}%    "
            f"fees paid {res.fees_pct:5.1f}%    time in market {res.time_in_market:.1f}%\n"
            f"buy&hold{res.buy_hold_pct:+9.1f}%    b&h drawdown {res.buy_hold_dd:6.1f}%    "
            f"avg hold {res.avg_hold_h:.1f}h    {res.trades_per_month:.1f} trades/month"))
        self.ax.clear()
        self.ax.set_facecolor(PANEL)
        eq = res.equity_curve
        self.ax.plot(eq, color=GREEN if res.ret_pct >= 0 else RED, lw=1.5)
        peak = np.maximum.accumulate(eq)
        self.ax.fill_between(range(len(eq)), eq, peak, color=RED, alpha=0.18)
        self.ax.set_title("equity by trade (shaded = drawdown from peak)", color=MUTED, fontsize=9)
        for sp in self.ax.spines.values():
            sp.set_color("#222a35")
        self.ax.tick_params(colors=MUTED, labelsize=8)
        self.ax.grid(alpha=0.12)
        self.fig.tight_layout()
        self.canvas.draw()

        self.tree.delete(*self.tree.get_children())
        t = pd.to_datetime(self.df["time"].to_numpy(), unit="s")
        for tr in reversed(res.trades):
            mv = (tr.exit / tr.entry - 1) * 100
            self.tree.insert("", "end", values=(
                f"{t[tr.entry_i]:%Y-%m-%d %H:%M}", f"{tr.entry:,.4g}", f"{tr.stop:,.4g}",
                f"{tr.exit:,.4g}", tr.reason, f"{mv:+.2f}%",
                "—" if tr.reason == "open" else f"{tr.r:+.2f}", tr.bars,
                "—" if tr.reason == "open" else f"{tr.equity:.3f}"))

        lines = ["CHRONOLOGICAL FOLDS  (a strategy that only works in one third is not a strategy)", ""]
        for i, f in enumerate(fo):
            lines.append(f"  fold {'ABC'[i]}   {f.line()}")
        pos = sum(1 for f in fo if f.expectancy_r > 0)
        lines += ["", f"  {pos}/3 folds positive", "", "QUARTERS", ""]
        for q, r in qu.items():
            lines.append(f"  {q}   {r.line()}")
        neg = sum(1 for r in qu.values() if r.ret_pct < 0)
        lines += ["", f"  {neg}/{len(qu)} losing quarters", "",
                  "params used: " + ", ".join(f"{k}={v:g}" for k, v in used.items()),
                  "",
                  "NOTE: drawdown is measured trade-to-trade, not marked to market inside a",
                  "trade, so the drawdown you would actually live through is worse than shown.",
                  "Slippage is not modelled."]
        self.folds_lbl.config(text="\n".join(lines))
        self.status.config(text=f"done — {res.n} trades")

    def _render_sweep(self, rows):
        self.stree.delete(*self.stree.get_children())
        for label, r, worst in rows:
            self.stree.insert("", "end", values=(
                label, r.n, f"{r.win_rate:.1f}", f"{r.profit_factor:.2f}", f"{r.ret_pct:+.1f}",
                f"{r.max_dd:.1f}", f"{r.trades_per_month:.1f}", f"{r.avg_hold_h:.1f}",
                f"{worst:+.3f}"))
        self.status.config(text=f"sweep done — {len(rows)} configs (sorted by net return)")


if __name__ == "__main__":
    App().mainloop()
