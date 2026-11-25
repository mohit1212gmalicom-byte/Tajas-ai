import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntryInput {
  name: string;
  data: Buffer;
}

function buildZipBuffer(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const fileNameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const compressed = zlib.deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(8, 8); // compression method: deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5421, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(fileNameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    localParts.push(localHeader, fileNameBuf, compressed);

    // Central Directory Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10); // deflate
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(fileNameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, fileNameBuf);
    offset += localHeader.length + fileNameBuf.length + compressed.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

function collectDirectoryFiles(rootDir: string, relDir: string, out: ZipEntryInput[]): void {
  const fullDir = path.join(rootDir, relDir);
  if (!fs.existsSync(fullDir)) return;

  for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.env') || entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const relPath = path.posix.join(relDir, entry.name);
    const fullPath = path.join(rootDir, relPath);
    if (entry.isDirectory()) {
      collectDirectoryFiles(rootDir, relPath, out);
    } else if (entry.isFile() && !entry.name.endsWith('.db') && !entry.name.endsWith('.db-wal')) {
      out.push({
        name: `tejas-ai/${relPath}`,
        data: fs.readFileSync(fullPath),
      });
    }
  }
}

export function createProjectZipArchive(): Buffer {
  const rootDir = process.cwd();
  const entries: ZipEntryInput[] = [];

  const rootFiles = [
    '.env.example',
    '.gitignore',
    'index.html',
    'metadata.json',
    'package.json',
    'server.ts',
    'tsconfig.json',
    'vite.config.ts',
  ];

  for (const file of rootFiles) {
    const fullPath = path.join(rootDir, file);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      entries.push({
        name: `tejas-ai/${file}`,
        data: fs.readFileSync(fullPath),
      });
    }
  }

  collectDirectoryFiles(rootDir, 'server', entries);
  collectDirectoryFiles(rootDir, 'src', entries);

  const readme = `# TEJAS AI — भारत का अपना AI साथी
Developer: Mohit Jaat

## Quick Start
1. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`
2. Copy \`.env.example\` to \`.env\` and set your \`GEMINI_API_KEY\`:
   \`\`\`bash
   cp .env.example .env
   \`\`\`
3. Run development server (port 3000):
   \`\`\`bash
   npm run dev
   \`\`\`
4. Build & run production:
   \`\`\`bash
   npm run build
   npm start
   \`\`\`
`;

  entries.push({
    name: 'tejas-ai/README.md',
    data: Buffer.from(readme, 'utf8'),
  });

  return buildZipBuffer(entries);
}
