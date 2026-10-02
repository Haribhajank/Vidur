#!/usr/bin/env bash
# Verification runner (Git Bash). Usage: bash scripts/check.sh [step...]
# Steps: env | typecheck | test | lint | build | py   (default: env typecheck test lint)
# Output of each step is written to logs/<step>.log; a summary goes to logs/summary.log.
set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs

steps=("$@")
if [ ${#steps[@]} -eq 0 ]; then steps=(env typecheck test lint); fi

LOCK=logs/.check.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another check.sh run is in progress (remove $LOCK if stale)" >&2
  exit 3
fi
trap 'rmdir "$LOCK"' EXIT

: > logs/summary.log
run_step() {
  local name="$1"; shift
  local start=$SECONDS
  "$@" > "logs/${name}.log" 2>&1
  local code=$?
  echo "${name}: exit=${code} (${SECONDS}-${start}s)" | awk -v s="$start" -v e="$SECONDS" '{sub(/\([0-9]+-[0-9]+s\)/, "(" e-s "s)"); print}' >> logs/summary.log
  return $code
}

for step in "${steps[@]}"; do
  case "$step" in
    env)       run_step env bash -c 'echo "bash $BASH_VERSION"; node --version; npm --version; python --version' ;;
    typecheck) run_step typecheck npx tsc --noEmit ;;
    test)      run_step test npx vitest run ;;
    lint)      run_step lint npx eslint . ;;
    build)     run_step build npx next build ;;
    pyinstall) run_step pyinstall bash -c 'cd backend_ml && python -m pip install -q -r requirements-dev.txt' ;;
    py)        run_step py bash -c 'cd backend_ml && python -m pytest -q tests' ;;
    pycompile) run_step pycompile bash -c 'cd backend_ml && python -m py_compile main.py pipeline.py && echo compiled' ;;
    *)         echo "unknown step: $step" >> logs/summary.log ;;
  esac
done
echo "DONE" >> logs/summary.log
