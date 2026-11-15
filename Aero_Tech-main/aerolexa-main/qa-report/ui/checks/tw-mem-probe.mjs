// Standalone probe: how much memory does the Tailwind v4 CSS pass take?
import fs from "node:fs";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const css = fs.readFileSync("styles/globals.css", "utf8");
const t0 = Date.now();
const res = await postcss([tailwind()]).process(css, { from: "styles/globals.css" });
console.log(
  JSON.stringify({
    ms: Date.now() - t0,
    bytes: res.css.length,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  }),
);
