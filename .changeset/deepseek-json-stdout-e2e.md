---
"deepseek-lossless": patch
---

Route the sidecar dir notice through the harness logger so headless `--json` stdout stays clean NDJSON, and scope `run-e2e.sh` sidecars to the scratch `DSH_HOME=/tmp/e2e-dsh` from the README.
