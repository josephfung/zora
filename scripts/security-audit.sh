#!/bin/bash
set -e
echo "Running security wiring audit..."

grep -q "sanitizeToolOutput" src/orchestrator/orchestrator.ts || { echo "FAIL: sanitizeToolOutput not wired in orchestrator"; exit 1; }
grep -q "ApprovalQueue" src/orchestrator/orchestrator.ts || { echo "FAIL: ApprovalQueue not imported in orchestrator"; exit 1; }
grep -q "from.*patterns" src/security/prompt-defense.ts || { echo "FAIL: prompt-defense not importing from patterns.ts"; exit 1; }
grep -q "from.*patterns" src/channels/quarantine-processor.ts || { echo "FAIL: quarantine-processor not importing from patterns.ts"; exit 1; }

echo "Security wiring audit passed."
