import process from "node:process";

import { runDemo } from "./runtime.ts";

await runDemo(process.argv.slice(2));
