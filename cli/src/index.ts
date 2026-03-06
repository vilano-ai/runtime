function renderHelp(): string {
  return [
    "Vilano CLI scaffold",
    "",
    "Planned top-level command groups:",
    "  vilano project ...",
    "  vilano workflow ...",
    "  vilano run ...",
    "  vilano service ...",
    "  vilano signal ...",
    "  vilano dev",
    "  vilano daemon ...",
    "",
    "The concrete command model is documented in spec/v1_cli.md.",
  ].join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(renderHelp());
    return 0;
  }

  console.log("Vilano CLI scaffold. Command implementation is not wired yet.");
  console.log(`args=${JSON.stringify(argv)}`);
  return 0;
}
