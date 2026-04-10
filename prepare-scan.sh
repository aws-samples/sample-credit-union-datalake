#!/bin/bash
# Copies only project source files into a clean directory for code scanning
# Usage: ./prepare-scan.sh

SCAN_DIR="scan-output"

rm -rf "$SCAN_DIR"
mkdir -p "$SCAN_DIR/bin" "$SCAN_DIR/lib" "$SCAN_DIR/scripts" "$SCAN_DIR/sample-data" "$SCAN_DIR/layers"

# CDK source
cp bin/cdk.ts "$SCAN_DIR/bin/"
cp lib/*.ts "$SCAN_DIR/lib/"

# ETL scripts
cp scripts/*.py "$SCAN_DIR/scripts/"

# Config
cp cdk.json tsconfig.json package.json "$SCAN_DIR/"

# Sample data (for context)
cp sample-data/* "$SCAN_DIR/sample-data/" 2>/dev/null

echo "Scan-ready files copied to $SCAN_DIR/"
echo "File count: $(find "$SCAN_DIR" -type f | wc -l)"
