const lid = [
  "  .----------------------.",
  " / .==================. /|",
  "/_/__________________/ / |",
  "|  [::::::  <>  ::::::] | /",
  "'-----------------------'/",
];
const base = [
  ".-----------------------.",
  "| .-------------------. | |",
  "| |     o       o     | | |",
  "| '-------.   .-------' | |",
  "|_________|___|_________|/",
];
const title = "S H U L K E R";
const reset = "\x1b[0;48;2;0;0;0m";
const color = (r: number, g: number, b: number) => `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;
const edge = color(238, 195, 255);
const shadow = color(132, 89, 191);
const seeds = [4, 21, 13, 8, 18, 24, 6, 15];

export const startupDuration = 2_200;

/** The base stays fixed while the lid eases up and sparks drift inside the opening. */
export function startupFrame(elapsed: number, columns: number, rows: number): string[] | undefined {
  if (columns < 15 || rows < 7) return;
  const t = Math.min(1, Math.max(0, (elapsed - 100) / 1_030));
  const open = t * t * (3 - 2 * t);
  const pulse = Math.sin(Math.PI * t);
  const shell = color(181 + 44 * pulse, 125 + 32 * pulse, 239 + 16 * pulse);
  const artWidth = Math.max(...lid.map((line) => line.length), ...base.map((line) => line.length));
  const maxLift = Math.min(6, rows - 14);
  if (columns < artWidth + 3 || maxLift < 2) {
    const compact = [" .--------.", "|==========|", open > 0.35 ? "   * +  *" : "", "|  o    o  |", "'----------'", title];
    return compact.map((line) => " ".repeat(Math.floor((columns - 1 - line.length) / 2)) + edge + line + reset);
  }

  const indent = " ".repeat(Math.floor((columns - 1 - artWidth) / 2));
  const top = Math.floor((rows - 1 - (lid.length + maxLift + base.length + 2)) / 2);
  const gap = Math.round(maxLift * open);
  const sparks = Array.from({ length: gap }, () => Array<string>(artWidth).fill(" "));
  for (const [i, seed] of seeds.entries()) {
    const life = (elapsed - 230 - 76 * i) / (950 + i * 30);
    if (life < 0 || life >= 1 || !gap) continue;
    const row = gap - 1 - Math.floor(life * gap);
    const column = seed + Math.round(Math.sin(life * 4 + i) * 2);
    if (column < 0 || column >= artWidth) continue;
    const light = Math.sin(life * Math.PI);
    sparks[row][column] = color(115 + 129 * light, 72 + 141 * light, 165 + 90 * light)
      + (light > 0.65 ? "*" : light > 0.25 ? "+" : ".");
  }
  const paint = (line: string, tone: string) => indent + tone + line + reset;
  return [
    ...Array<string>(top + maxLift - gap).fill(""),
    ...lid.map((line, row) => paint(line, row < 3 ? edge : shell)),
    ...sparks.map((line) => indent + line.join("") + reset),
    ...base.map((line, row) => paint(line, row === 0 ? edge : row === 4 ? shadow : shell)),
    "",
    " ".repeat(Math.floor((columns - 1 - title.length) / 2)) + edge + "\x1b[1m" + title + reset,
  ];
}
