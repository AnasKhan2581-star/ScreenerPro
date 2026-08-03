"""Acceptance gate: the Python engine must reproduce detector.js on identical data.

Two engines that silently disagree are worse than one. This runs both on the same bars
and fails loudly if any headline stat drifts.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pytester import data, engine, strategies                     # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

JS = r"""
const SMC=require(process.argv[2]);
const rows=JSON.parse(require('fs').readFileSync(process.argv[3],'utf8'));
const r=SMC.detectAll(rows,{strategy:process.argv[4],longOnly:true,atrLen:14,htfMult:1,useLiq:false,liqTargets:false});
const T=r.trades.filter(t=>t.outcome!=='open');
const FEE=0.001,RISK=0.01;
let eq=1,pk=1,dd=0,w=0,gp=0,gl=0,sumR=0;
for(const t of T){const N=eq*RISK/((t.entry-t.stop)/t.entry);
 const net=(t.exitPrice-t.entry)/t.entry*N-(FEE*N+FEE*N*(t.exitPrice/t.entry));
 sumR+=net/(eq*RISK); if(net>=0){w++;gp+=net;}else gl-=net; eq+=net;
 if(eq>pk)pk=eq;else dd=Math.max(dd,(pk-eq)/pk);}
console.log(JSON.stringify({n:T.length,wr:T.length?w/T.length*100:0,pf:gl>0?gp/gl:(gp>0?-1:0),
 expR:T.length?sumR/T.length:0,ret:(eq-1)*100,dd:dd*100,
 entries:T.slice(0,5).map(t=>[t.entryIdx,+t.entry.toFixed(4),+t.stop.toFixed(4)])}));
"""


def js_result(df: pd.DataFrame, key: str) -> dict:
    tmp = Path(__file__).parent / "_verify_bars.json"
    runner = Path(__file__).parent / "_verify_run.js"
    tmp.write_text(json.dumps(df.to_dict("records")))
    runner.write_text(JS)
    out = subprocess.run(
        [ "node", str(runner), str(ROOT / "detector.js"), str(tmp), key ],
        capture_output=True, text=True, cwd=str(ROOT))
    tmp.unlink(missing_ok=True); runner.unlink(missing_ok=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr[:400])
    return json.loads(out.stdout.strip().splitlines()[-1])


def main() -> int:
    symbol, interval, bars = "ZECUSDT", "15m", 30000
    print(f"fetching {symbol} {interval} x{bars} ...")
    df = data.load(symbol, interval, bars, refresh=False)
    print(" ", data.describe(df))
    bad = 0
    for key in ("liqbrk", "donch", "tsmom"):
        trades, _ = strategies.run(key, df, fill="close")
        py = engine.evaluate(trades, df, fee_pct=0.1, sizing="risk", size_pct=1.0)
        js = js_result(df, key)
        # -1 is the shared sentinel for "wins but zero losses"; 0 is a genuine PF of zero
        pf_py = -1.0 if py.profit_factor == float("inf") else py.profit_factor
        pf_js = js["pf"]
        checks = [("n", py.n, js["n"], 0), ("WR%", py.win_rate, js["wr"], 0.15),
                  ("PF", pf_py, pf_js, 0.02),
                  ("expR", py.expectancy_r, js["expR"], 0.01),
                  ("ret%", py.ret_pct, js["ret"], 0.5), ("DD%", py.max_dd, js["dd"], 0.2)]
        ok = all(abs(a - b) <= tol for _, a, b, tol in checks)
        bad += 0 if ok else 1
        print(f"\n{key:8s} {'MATCH' if ok else 'MISMATCH'}")
        for nm, a, b, tol in checks:
            flag = "" if abs(a - b) <= tol else "   <-- DRIFT"
            print(f"   {nm:5s} python {a:12.4f}   js {b:12.4f}{flag}")
    print("\n" + ("ALL STRATEGIES MATCH detector.js" if not bad
                  else f"{bad} strategy(ies) DRIFTED — fix before trusting the desktop tester"))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
