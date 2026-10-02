#!/usr/bin/env bash
# Initial commit + push. Output: logs/git-push.log
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
rm -f scripts/cleanup-scratch.sh
{
  echo "== secret scan (staged candidates)"
  git add -A
  PATTERN='sk-ant-(api|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\.eyJ[A-Za-z0-9_-]{20,}|postgres(ql)?://[A-Za-z0-9._-]+:[^@[:space:]]{12,}@[a-z0-9.-]+\.(supabase|neon)'
  if git diff --cached -U0 -- . ':(exclude)scripts/git-push.sh' | grep -nE "^\+.*(${PATTERN})" ; then
    echo "POSSIBLE SECRET FOUND - aborting"; git reset -q; exit 1
  fi
  echo "none found"
  echo "== staged files"; git diff --cached --name-only | wc -l
  echo "== largest staged files (KB)"
  git diff --cached --name-only -z | xargs -0 du -k 2>/dev/null | sort -rn | head -n 5
  echo "== commit"
  git commit -q -m "Initial commit: BookMentor AI (Next.js app, FSRS engine, Claude orchestrator, ML ingestion service)" && git --no-pager log --oneline -n 1
  echo "== push"
  GIT_TERMINAL_PROMPT=0 timeout 180 git push -u origin main 2>&1
  echo "push exit=$?"
  echo "== verify"
  git status -sb | head -n 3
  GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote --heads origin 2>&1
  echo "== END"
} > logs/git-push.log 2>&1
