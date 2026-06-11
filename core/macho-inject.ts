// 最小化 Mach-O LC_LOAD_DYLIB 注入器（thin arm64，64-bit）。
// 用於把自製 loader dylib 加進 BrownDustII 主程式（取代 dev 期的 python lief）。
// 作法與 PlayCover/insert_dylib 相同：在 load commands 後方的 padding 內插入一條
// LC_LOAD_DYLIB，並更新 ncmds / sizeofcmds。插入後需用 codesign 重簽。

import fs from "node:fs";

const MH_MAGIC_64 = 0xfeedfacf;
const LC_LOAD_DYLIB = 0x0c;
const LC_SEGMENT_64 = 0x19;
const HEADER_SIZE = 32; // mach_header_64
const DYLIB_CMD_HEADER = 24; // cmd,cmdsize,name.offset,timestamp,current_version,compat_version

function align8(n: number) {
  return (n + 7) & ~7;
}

export interface InjectResult {
  ok: boolean;
  reason?: string;
  alreadyPresent?: boolean;
}

/** 檢查主程式是否已含指向 dylibName 的 LC_LOAD_DYLIB。 */
export function hasLoadDylib(filePath: string, dylibName: string): boolean {
  const buf = fs.readFileSync(filePath);
  return findLoadDylib(buf, dylibName);
}

function findLoadDylib(buf: Buffer, dylibName: string): boolean {
  if (buf.readUInt32LE(0) !== MH_MAGIC_64) return false;
  const ncmds = buf.readUInt32LE(16);
  let off = HEADER_SIZE;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmd === LC_LOAD_DYLIB) {
      const nameOff = buf.readUInt32LE(off + 8);
      const end = buf.indexOf(0, off + nameOff);
      const name = buf.toString("utf8", off + nameOff, end < 0 ? off + cmdsize : end);
      if (name === dylibName) return true;
    }
    off += cmdsize;
  }
  return false;
}

/** 在 padding 內插入一條 LC_LOAD_DYLIB 指向 dylibName，原地改寫 filePath。 */
export function addLoadDylib(filePath: string, dylibName: string): InjectResult {
  const buf = fs.readFileSync(filePath);
  if (buf.readUInt32LE(0) !== MH_MAGIC_64) {
    return { ok: false, reason: "不是 thin arm64 Mach-O（magic 不符）" };
  }
  if (findLoadDylib(buf, dylibName)) {
    return { ok: true, alreadyPresent: true };
  }

  const ncmds = buf.readUInt32LE(16);
  const sizeofcmds = buf.readUInt32LE(20);
  const loadEnd = HEADER_SIZE + sizeofcmds;

  // 計算可用 padding：load commands 必須結束於第一個 section 資料之前。
  let lowestSectionOffset = Number.MAX_SAFE_INTEGER;
  let off = HEADER_SIZE;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmd === LC_SEGMENT_64) {
      const nsects = buf.readUInt32LE(off + 64);
      let sec = off + 72; // segment_command_64 為 72 bytes
      for (let s = 0; s < nsects; s++) {
        const secSize = Number(buf.readBigUInt64LE(sec + 40));
        const secOffset = buf.readUInt32LE(sec + 48);
        if (secSize > 0 && secOffset > 0 && secOffset < lowestSectionOffset) {
          lowestSectionOffset = secOffset;
        }
        sec += 80; // section_64 為 80 bytes
      }
    }
    off += cmdsize;
  }

  const nameBytes = Buffer.from(dylibName, "utf8");
  const newCmdSize = align8(DYLIB_CMD_HEADER + nameBytes.length + 1);
  const freeSpace = lowestSectionOffset - loadEnd;
  if (freeSpace < newCmdSize) {
    return { ok: false, reason: `load commands padding 不足（需 ${newCmdSize}，剩 ${freeSpace}）` };
  }

  // 組裝 LC_LOAD_DYLIB
  const cmd = Buffer.alloc(newCmdSize); // 已歸零（含 name 尾端 padding）
  cmd.writeUInt32LE(LC_LOAD_DYLIB, 0);
  cmd.writeUInt32LE(newCmdSize, 4);
  cmd.writeUInt32LE(DYLIB_CMD_HEADER, 8); // dylib.name offset
  cmd.writeUInt32LE(2, 12); // timestamp
  cmd.writeUInt32LE(0x10000, 16); // current_version 1.0.0
  cmd.writeUInt32LE(0x10000, 20); // compatibility_version 1.0.0
  nameBytes.copy(cmd, DYLIB_CMD_HEADER);

  // 寫入 padding 區、更新 header
  cmd.copy(buf, loadEnd);
  buf.writeUInt32LE(ncmds + 1, 16);
  buf.writeUInt32LE(sizeofcmds + newCmdSize, 20);

  fs.writeFileSync(filePath, buf);
  return { ok: true };
}
