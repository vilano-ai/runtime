#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const distEntry = path.join(__dirname, "..", "dist", "index.js");

if (!fs.existsSync(distEntry)) {
  console.error("Vilano CLI scaffold exists, but the TypeScript sources have not been built yet.");
  process.exit(1);
}

Promise.resolve()
  .then(() => require(distEntry))
  .then((mod) => mod.main(process.argv.slice(2)))
  .then((code) => {
    process.exitCode = typeof code === "number" ? code : 0;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
