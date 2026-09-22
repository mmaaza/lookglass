/**
 * The docx-preview path reads the whole file, so it checks the package's
 * inflated sizes from the in-memory directory before handing it over. The
 * directory parser itself is shared with the range-based reader.
 */
export { readZipDirectory as readZipEntries, type ZipEntry } from '../../ooxml/zip.js';
