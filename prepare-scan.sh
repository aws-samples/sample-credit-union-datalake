#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Copies only project source files into a clean directory for code scanning.
# Excludes sample data (synthetic test data) and third-party libraries.
# Usage: ./prepare-scan.sh

SCAN_DIR="security/scans/scan-output"

rm -rf "$SCAN_DIR"
mkdir -p "$SCAN_DIR/bin" "$SCAN_DIR/lib" "$SCAN_DIR/scripts"

# CDK source (exclude .d.ts build artifacts)
cp bin/cdk.ts "$SCAN_DIR/bin/"
for f in lib/*.ts; do
  case "$f" in *.d.ts) continue;; esac
  cp "$f" "$SCAN_DIR/lib/"
done

# ETL scripts
cp scripts/*.py "$SCAN_DIR/scripts/"

# Config and docs
cp cdk.json tsconfig.json package.json "$SCAN_DIR/"
cp README.md LICENSE NOTICE CODE_OF_CONDUCT.md CONTRIBUTING.md "$SCAN_DIR/" 2>/dev/null
cp -r docs/ "$SCAN_DIR/docs/" 2>/dev/null

echo "Scan-ready files copied to $SCAN_DIR/"
echo "File count: $(find "$SCAN_DIR" -type f | wc -l)"
echo ""
echo "Excluded (not scanned):"
echo "  - sample-data/   (synthetic test data, not production code)"
echo "  - layers/        (third-party pymysql library)"
echo "  - node_modules/  (npm dependencies)"
echo "  - *.d.ts         (TypeScript build artifacts)"
