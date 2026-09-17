/**
 * Minimal PDF writer for test fixtures.
 *
 * Hand-rolled rather than a dependency because the fixtures need precise
 * control over structure: non-embedded CID fonts (to prove CMap assets load
 * offline), an uncompressed page body of known size (to prove range loading
 * fetches a fraction of the file), and standard-security encryption (to drive
 * the password flow). General PDF libraries tend to "helpfully" embed fonts or
 * refuse to write encryption.
 */
import { createHash } from 'node:crypto';

const PAD = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
);

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();

function padPassword(password) {
  return Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);
}

/**
 * Standard security handler, revision 2 (40-bit RC4). Weak by modern
 * standards, which is irrelevant for a fixture: it is the variant every PDF
 * reader must support, so it exercises the password path without depending
 * on AES support.
 */
function standardSecurity(userPassword, ownerPassword, fileId) {
  const permissions = -4;
  const ownerKey = md5(padPassword(ownerPassword)).subarray(0, 5);
  const O = rc4(ownerKey, padPassword(userPassword));
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const key = md5(padPassword(userPassword), O, p, fileId).subarray(0, 5);
  const U = rc4(key, PAD);
  return {
    key,
    dict: `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${permissions} >>`,
    objectKey(num, gen = 0) {
      const suffix = Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
      return md5(key, suffix).subarray(0, 10);
    },
  };
}

export class PdfBuilder {
  #objects = [];

  /** Reserve an object number to reference before its content exists. */
  reserve() {
    this.#objects.push(null);
    return this.#objects.length;
  }

  set(num, dict, stream) {
    this.#objects[num - 1] = { dict, stream: stream === undefined ? undefined : Buffer.from(stream) };
    return num;
  }

  add(dict, stream) {
    return this.set(this.reserve(), dict, stream);
  }

  /**
   * @param {{ root: number, info?: number, userPassword?: string }} opts
   */
  build({ root, info, userPassword }) {
    const fileId = md5(Buffer.from(`lookglass-fixture-${this.#objects.length}`));
    const security = userPassword !== undefined ? standardSecurity(userPassword, 'owner', fileId) : undefined;
    const encryptNum = security ? this.add(security.dict) : undefined;

    const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];

    this.#objects.forEach((object, index) => {
      const num = index + 1;
      if (!object) throw new Error(`object ${num} was reserved but never set`);
      offsets.push(offset);

      let stream = object.stream;
      let dict = object.dict;
      if (stream) {
        // The encryption dictionary itself is never encrypted.
        if (security && num !== encryptNum) stream = rc4(security.objectKey(num), stream);
        dict = dict.replace(/>>\s*$/, ` /Length ${stream.length} >>`);
      }

      const head = Buffer.from(`${num} 0 obj\n${dict}\n`, 'latin1');
      const parts = stream
        ? [head, Buffer.from('stream\n'), stream, Buffer.from('\nendstream\nendobj\n')]
        : [head, Buffer.from('endobj\n')];
      for (const part of parts) {
        chunks.push(part);
        offset += part.length;
      }
    });

    const xrefOffset = offset;
    const rows = offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
    const trailer = [
      `/Size ${this.#objects.length + 1}`,
      `/Root ${root} 0 R`,
      info ? `/Info ${info} 0 R` : '',
      encryptNum ? `/Encrypt ${encryptNum} 0 R` : '',
      `/ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]`,
    ]
      .filter(Boolean)
      .join(' ');

    chunks.push(
      Buffer.from(
        `xref\n0 ${this.#objects.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< ${trailer} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
        'latin1',
      ),
    );
    return Buffer.concat(chunks);
  }
}

/** Escape a PDF literal string. */
export function literal(text) {
  return `(${text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}
