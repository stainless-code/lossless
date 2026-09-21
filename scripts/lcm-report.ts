import { buildReport, collectMetricsEvents } from "../packages/core/src/report.ts";

const events = collectMetricsEvents();
if (events.length === 0) {
  console.log("No metrics found (~/.pi/agent/lcm/metrics.jsonl).");
  process.exit(0);
}
console.log(buildReport(events));
