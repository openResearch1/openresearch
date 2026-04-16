#!/usr/bin/env bash
#
# Download LongMemEval dataset from HuggingFace
#
# Usage:
#   bash test/eval/longmemeval/download-dataset.sh [target_dir]
#
# Default target: test/eval/longmemeval/data/
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$SCRIPT_DIR/data}"

BASE_URL="https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main"

FILES=(
  "longmemeval_oracle.json"
  "longmemeval_s_cleaned.json"
  "longmemeval_m_cleaned.json"
)

mkdir -p "$TARGET_DIR"

echo "Downloading LongMemEval dataset to $TARGET_DIR ..."

for file in "${FILES[@]}"; do
  dest="$TARGET_DIR/$file"
  if [ -f "$dest" ]; then
    echo "  [skip] $file (already exists)"
  else
    echo "  [download] $file ..."
    curl -fSL "$BASE_URL/$file" -o "$dest"
    echo "  [done] $file ($(du -h "$dest" | cut -f1))"
  fi
done

echo ""
echo "Dataset files:"
ls -lh "$TARGET_DIR"/*.json 2>/dev/null || echo "  (none found)"
echo ""
echo "Done. Run evaluation with:"
echo "  bun test/eval/longmemeval/run-eval.ts --dataset $TARGET_DIR/longmemeval_s_cleaned.json"
