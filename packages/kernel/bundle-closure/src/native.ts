/**
 * Whether a compiled Node addon (a `.node` file) was built for the one target a bundle can carry
 * native code for: linux on x64 under Node 22.
 *
 * The file is read, never loaded. Its header must be a 64-bit little-endian ELF shared object for
 * x86-64 with the System V or GNU/Linux ABI. The Node ABI is taken from the registration symbol the
 * addon exports: an addon built on Node-API exports `napi_register_module_v1` and runs on every Node
 * release; an addon built against one Node release exports `node_register_module_v<N>`, and only
 * `N` = 127 is Node 22. An addon exporting neither cannot be checked and is refused.
 *
 * Any other file of a vendored package is checked by its first bytes as well: an ELF, Mach-O or
 * Windows PE binary (an executable a package spawns, a shared library it loads) must be an ELF file
 * for x86-64 Linux. A package whose `os` or `cpu` field in its `package.json` excludes linux or x64
 * is a platform-specific build for another machine and is refused as well.
 */

/** The Node module ABI version of Node 22. */
export const NODE_22_MODULE_VERSION = 127;

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFOSABI_SYSV = 0;
const ELFOSABI_LINUX = 3;
const ET_DYN = 3;
const EM_X86_64 = 62;

const ELF_MACHINES: Readonly<Record<number, string>> = {
  3: 'x86',
  40: 'arm',
  62: 'x64',
  183: 'arm64',
  243: 'riscv64',
};

const NAPI_SYMBOL = Buffer.from('napi_register_module_v1', 'ascii');
const NODE_SYMBOL = Buffer.from('node_register_module_v', 'ascii');

/** The verdict on one addon: built for the target, or the platform or ABI it was built for. */
export type AddonVerdict = { ok: true } | { ok: false; builtFor: string };

export function inspectAddon(bytes: Uint8Array): AddonVerdict {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const platform = platformOf(b);
  if (platform !== 'linux/x64') return { ok: false, builtFor: platform };
  if (b.indexOf(NAPI_SYMBOL) >= 0) return { ok: true };
  const versions = new Set<number>();
  let at = b.indexOf(NODE_SYMBOL);
  while (at >= 0) {
    let end = at + NODE_SYMBOL.length;
    while (end < b.length && b[end]! >= 0x30 && b[end]! <= 0x39) end++;
    const digits = b.toString('ascii', at + NODE_SYMBOL.length, end);
    if (digits.length > 0) versions.add(Number(digits));
    at = b.indexOf(NODE_SYMBOL, end);
  }
  if (versions.size === 1 && versions.has(NODE_22_MODULE_VERSION)) return { ok: true };
  if (versions.size === 0) {
    return { ok: false, builtFor: 'linux/x64 with no Node registration symbol to check' };
  }
  return {
    ok: false,
    builtFor: `linux/x64 for Node module ABI ${[...versions].sort((x, y) => x - y).join(', ')}`,
  };
}

/** How many leading bytes `nativeBinaryPlatform` needs. */
export const NATIVE_HEADER_BYTES = 4096;

/**
 * The platform of a native binary from its first bytes, or `undefined` when the bytes are not the
 * start of an ELF, Mach-O or Windows PE file. `linux/x64` is the one platform a bundle carries.
 */
export function nativeBinaryPlatform(head: Uint8Array): string | undefined {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length >= 4 && ELF_MAGIC.every((byte, i) => b[i] === byte)) {
    if (b.length < 20) return 'a truncated ELF file';
    const little = b[5] === ELFDATA2LSB;
    const machine = little ? b.readUInt16LE(18) : b.readUInt16BE(18);
    const osAbi = b[7];
    if (
      b[4] === ELFCLASS64 &&
      little &&
      (osAbi === ELFOSABI_SYSV || osAbi === ELFOSABI_LINUX) &&
      machine === EM_X86_64
    ) {
      return 'linux/x64';
    }
    return `linux/${ELF_MACHINES[machine] ?? `machine ${machine}`}`;
  }
  if (b.length >= 8) {
    const magic = b.readUInt32BE(0);
    if (MACH_O_MAGICS.has(magic)) return 'macOS';
    // A universal Mach-O starts like a Java class file; its next word counts architectures, where
    // a class file has its version, 45 or more.
    if (magic === 0xcafebabe && b.readUInt32BE(4) < 45) return 'macOS (universal binary)';
  }
  if (b.length >= 0x40 && b[0] === 0x4d && b[1] === 0x5a) {
    const offset = b.readUInt32LE(0x3c);
    if (offset + 4 <= b.length && b.readUInt32BE(offset) === PE_SIGNATURE) return 'Windows';
  }
  return undefined;
}

/**
 * Whether a package's `os` and `cpu` fields let it install on linux/x64. Each field is a list of
 * allowed names, or of names prefixed with `!` that are denied; an absent field allows everything.
 * Returns the platform the fields name when they exclude linux/x64.
 */
export function packagePlatformExclusion(manifest: Record<string, unknown>): string | undefined {
  const os = fieldList(manifest.os);
  const cpu = fieldList(manifest.cpu);
  const allows = (list: string[] | undefined, value: string) => {
    if (list === undefined || list.length === 0) return true;
    if (list.includes(`!${value}`)) return false;
    const allowed = list.filter((entry) => !entry.startsWith('!'));
    return allowed.length === 0 || allowed.includes(value);
  };
  if (allows(os, 'linux') && allows(cpu, 'x64')) return undefined;
  return `${os?.join(', ') ?? 'any os'} / ${cpu?.join(', ') ?? 'any cpu'}`;
}

function fieldList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

const MACH_O_MAGICS: ReadonlySet<number> = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
]);
const PE_SIGNATURE = 0x50450000;

/** The platform a binary's header names, as `os/arch` or a description. */
function platformOf(b: Buffer): string {
  if (b.length >= 4 && ELF_MAGIC.every((byte, i) => b[i] === byte)) {
    if (b.length < 20) return 'a truncated ELF file';
    const bits = b[4] === ELFCLASS64 ? '64-bit' : '32-bit';
    const little = b[5] === ELFDATA2LSB;
    const osAbi = b[7];
    const type = little ? b.readUInt16LE(16) : b.readUInt16BE(16);
    const machine = little ? b.readUInt16LE(18) : b.readUInt16BE(18);
    const arch = ELF_MACHINES[machine] ?? `machine ${machine}`;
    if (
      b[4] === ELFCLASS64 &&
      little &&
      (osAbi === ELFOSABI_SYSV || osAbi === ELFOSABI_LINUX) &&
      type === ET_DYN &&
      machine === EM_X86_64
    ) {
      return 'linux/x64';
    }
    if (type !== ET_DYN) return `an ELF file that is not a shared object (${arch})`;
    return `linux/${arch} (${bits}${little ? '' : ', big-endian'}${
      osAbi === ELFOSABI_SYSV || osAbi === ELFOSABI_LINUX ? '' : `, OS ABI ${osAbi}`
    })`;
  }
  if (b.length >= 4) {
    const magic = b.readUInt32BE(0);
    if (magic === 0xcffaedfe || magic === 0xcefaedfe || magic === 0xfeedfacf) return 'macOS';
    if (magic === 0xcafebabe) return 'macOS (universal binary)';
  }
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return 'Windows';
  return 'an unknown format';
}
