#!/bin/bash
cd "$(dirname "$0")"
for size in 1M 5M; do
  reps=3; [ $size = 5M ] && reps=2
  for r in $(seq 1 $reps); do
    for e in duckdb polars; do
      ./venv/bin/python bench.py $e vendas_$size.csv res/${e}_${size}_$r.json > res/${e}_${size}_$r.log 2>&1
      echo "$e $size $r exit $?"
    done
  done
done
