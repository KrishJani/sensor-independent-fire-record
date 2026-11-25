// Writes docs/APP_GUIDE.md from the guide module (src/index.ts is the source; never edit the .md by hand).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guideMarkdown } from "../src/index.ts";

const out = fileURLToPath(new URL("../../../docs/APP_GUIDE.md", import.meta.url));
writeFileSync(out, guideMarkdown());
console.log(`wrote ${out}`);
