#!/usr/bin/env bash
# Run the viewer scenario (drawer + window) on every ref; results appended to handoffs/2026-10-15_S35_viewer-regression.txt
OUT=/home/user/webapp/handoffs/2026-10-15_S35_viewer-regression-raw.txt
: > "$OUT"
for spec in "wt-main main" "wt-984fa62_1 984fa62~1" "wt-984fa62 984fa62" "wt-b36f6ba b36f6ba" "wt-491de46 491de46(origin)" "webapp HEAD+fix"; do
  set -- $spec
  for m in drawer window; do
    echo "===== ref=$2 mode=$m =====" >> "$OUT"
    timeout 300 bash /home/user/webapp/tools/s35/run-ref.sh /home/user/$1 "$2" $m >> "$OUT" 2>&1 < /dev/null
  done
done
echo ALLDONE >> "$OUT"
