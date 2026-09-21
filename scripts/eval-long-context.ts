import {
  formatEvalTable,
  runEval,
  SMALL_SEED,
  type EvalResult,
} from "../packages/core/src/eval.ts";

interface Args {
  turns: number[];
  needles: number;
  passes: number;
  fillerChars: number;
  seed: number;
  db?: string;
  record: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    turns: [200, 800, 3_200],
    needles: 24,
    passes: 6,
    fillerChars: 400,
    seed: SMALL_SEED,
    record: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split("=");
    const next = (): string => inline ?? argv[++i] ?? "";
    switch (flag) {
      case "--turns":
        args.turns = next()
          .split(",")
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0);
        break;
      case "--needles":
        args.needles = Number(next());
        break;
      case "--passes":
        args.passes = Number(next());
        break;
      case "--filler":
        args.fillerChars = Number(next());
        break;
      case "--seed":
        args.seed = Number(next());
        break;
      case "--db":
        args.db = next();
        break;
      case "--no-record":
        args.record = false;
        break;
      default:
        console.error(`Unknown flag ${flag}`);
        process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const results: EvalResult[] = [];
for (const turns of args.turns) {
  const result = await runEval(
    {
      seed: args.seed,
      turns,
      needles: Math.min(args.needles, turns),
      fillerChars: args.fillerChars,
    },
    {
      passes: args.passes,
      ...(args.db === undefined ? {} : { dbPath: `${args.db}.${turns}` }),
      record: args.record,
    },
  );
  results.push(result);
  console.error(`${turns} turns: ${result.passes} pass(es), ${result.summaries} summaries`);
}
console.log(formatEvalTable(results));
const failed = results.reduce((n, r) => n + r.failed, 0);
const unfaithful = results.reduce((n, r) => n + (r.needles - r.fidelity), 0);
if (failed > 0 || unfaithful > 0) {
  console.error(`FAILED: ${failed} unanswerable needle(s), ${unfaithful} unretrievable`);
  process.exit(1);
}
