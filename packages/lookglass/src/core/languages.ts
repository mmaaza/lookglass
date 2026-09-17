/**
 * File extension to syntax-highlighting language.
 *
 * Kept free of any highlighter import so the main thread can decide whether
 * highlighting applies without loading the tokenizer. The grammars themselves
 * are only ever loaded inside the text worker, one language at a time.
 *
 * JSON, XML, Markdown and SVG are absent on purpose: they have their own
 * structured renderers, which are more useful than coloured source.
 */
export const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  pyw: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  env: 'dotenv',
  dockerfile: 'docker',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  dart: 'dart',
  r: 'r',
  scala: 'scala',
  hs: 'haskell',
  ex: 'elixir',
  exs: 'elixir',
  pl: 'perl',
  mk: 'makefile',
  proto: 'protobuf',
  tf: 'terraform',
  hcl: 'hcl',
  zig: 'zig',
});

/** Whole-filename matches for files that conventionally have no extension. */
const FILENAME_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  dockerfile: 'docker',
  makefile: 'makefile',
  '.env': 'dotenv',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
});

export function languageFor(name: string | undefined, ext: string | undefined): string | undefined {
  const base = name?.split(/[\\/]/).pop()?.toLowerCase();
  if (base && FILENAME_LANGUAGE[base]) return FILENAME_LANGUAGE[base];
  return ext ? EXTENSION_LANGUAGE[ext.toLowerCase()] : undefined;
}

/** Extensions that are source code, so detection should not reinterpret them. */
export function isCodeExtension(ext: string | undefined): boolean {
  return ext !== undefined && Object.hasOwn(EXTENSION_LANGUAGE, ext.toLowerCase());
}
