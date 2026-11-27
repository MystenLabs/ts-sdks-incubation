/**
 * Cursor desktop's stdio parsing contract (probed on 3.24.18), observed in its installed
 * mcpProcessMain.js and reproduced against a real launcher. Empty args trigger
 * literal space splitting (quotes do not protect the command). Nonempty args
 * preserve command as the executable. This fixture is independent of our writer.
 */
export function cursorCommand(entry: { command: string; args: string[] }) {
  if (entry.args.length > 0) return { file: entry.command, args: entry.args };
  const [file, ...args] = entry.command.split(" ");
  return { file: file!, args };
}
