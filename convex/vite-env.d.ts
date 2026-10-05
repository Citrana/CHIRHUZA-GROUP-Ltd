interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
  // Eagerly load matching files as raw text (used by source-guard tests).
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
