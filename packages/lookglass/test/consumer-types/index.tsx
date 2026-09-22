// Resolve built public exports with a consumer's DOM-only lib configuration.
// Importing a viewer must not require the conflicting lib.webworker globals.
import { FileViewer } from 'lookglass/react';
import type * as root from 'lookglass';
import type * as headless from 'lookglass/headless';
import type * as server from 'lookglass/server';
import type * as sw from 'lookglass/sw';
import type * as text from 'lookglass/text';
import type * as image from 'lookglass/image';
import type * as json from 'lookglass/json';
import type * as xml from 'lookglass/xml';
import type * as markdown from 'lookglass/markdown';
import type * as svg from 'lookglass/svg';
import type * as pdf from 'lookglass/pdf';
import type * as docx from 'lookglass/docx';
import type * as csv from 'lookglass/csv';
import type * as sheet from 'lookglass/sheet';

export const preview = <FileViewer source={new Blob(['hello'])} />;
export type PublicExports = [
  typeof root, typeof headless, typeof server, typeof sw, typeof text,
  typeof image, typeof json, typeof xml, typeof markdown, typeof svg,
  typeof pdf, typeof docx, typeof csv, typeof sheet,
];
