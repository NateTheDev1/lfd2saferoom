use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

const SIGNATURE: u32 = 0x55aa_1234;
const EMBEDDED_ARCHIVE: u16 = 0x7fff;

#[derive(Debug, Clone)]
pub struct Entry {
    pub path: String,
    pub crc: u32,
    pub len: u32,
}

pub struct Vpk {
    pub entries: Vec<Entry>,
    pub addoninfo: Option<Vec<u8>>,
}

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

impl Cursor<'_> {
    fn take(&mut self, n: usize) -> io::Result<&[u8]> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.buf.len());
        let end = end.ok_or_else(|| invalid("directory tree is truncated"))?;
        let slice = &self.buf[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u16(&mut self) -> io::Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> io::Result<u32> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn cstr(&mut self) -> io::Result<String> {
        let rest = &self.buf[self.pos.min(self.buf.len())..];
        let len = rest
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| invalid("unterminated string in directory tree"))?;
        let s = String::from_utf8_lossy(&rest[..len]).into_owned();
        self.pos += len + 1;
        Ok(s)
    }
}

fn join_path(dir: &str, name: &str, ext: &str) -> String {
    let mut path = String::new();
    let dir = dir.trim().replace('\\', "/");
    let dir = dir.trim_matches('/');
    if !dir.is_empty() {
        path.push_str(dir);
        path.push('/');
    }
    path.push_str(name);
    if !ext.trim().is_empty() {
        path.push('.');
        path.push_str(ext);
    }
    path.to_ascii_lowercase()
}

struct InfoLocation {
    preload_pos: usize,
    preload_len: usize,
    archive: u16,
    offset: u32,
    length: u32,
}

pub fn read(path: &Path) -> io::Result<Vpk> {
    let mut file = File::open(path)?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header)?;
    let word = |i: usize| u32::from_le_bytes([header[i], header[i + 1], header[i + 2], header[i + 3]]);
    if word(0) != SIGNATURE {
        return Err(invalid("not a VPK file"));
    }
    let tree_size = word(8) as usize;
    let header_len: u64 = match word(4) {
        1 => 12,
        2 => {
            file.seek(SeekFrom::Current(16))?;
            28
        }
        v => return Err(invalid(&format!("unsupported VPK version {v}"))),
    };
    if tree_size > 512 * 1024 * 1024 {
        return Err(invalid("directory tree is implausibly large"));
    }
    let mut tree = vec![0u8; tree_size];
    file.read_exact(&mut tree)?;
    let data_start = header_len + tree_size as u64;

    let mut cur = Cursor { buf: &tree, pos: 0 };
    let mut entries = Vec::new();
    let mut info = None;
    loop {
        let ext = cur.cstr()?;
        if ext.is_empty() {
            break;
        }
        loop {
            let dir = cur.cstr()?;
            if dir.is_empty() {
                break;
            }
            loop {
                let name = cur.cstr()?;
                if name.is_empty() {
                    break;
                }
                let crc = cur.u32()?;
                let preload_len = cur.u16()? as usize;
                let archive = cur.u16()?;
                let offset = cur.u32()?;
                let length = cur.u32()?;
                let _terminator = cur.u16()?;
                let preload_pos = cur.pos;
                cur.take(preload_len)?;
                let path = join_path(&dir, &name, &ext);
                if path == "addoninfo.txt" {
                    info = Some(InfoLocation { preload_pos, preload_len, archive, offset, length });
                }
                entries.push(Entry { path, crc, len: preload_len as u32 + length });
            }
        }
    }

    let addoninfo = info.and_then(|loc| {
        let mut data = tree[loc.preload_pos..loc.preload_pos + loc.preload_len].to_vec();
        if loc.length > 0 {
            if loc.archive != EMBEDDED_ARCHIVE {
                return None;
            }
            file.seek(SeekFrom::Start(data_start + loc.offset as u64)).ok()?;
            let mut buf = vec![0u8; loc.length as usize];
            file.read_exact(&mut buf).ok()?;
            data.extend(buf);
        }
        Some(data)
    });

    Ok(Vpk { entries, addoninfo })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_paths() {
        assert_eq!(join_path(" ", "addoninfo", "txt"), "addoninfo.txt");
        assert_eq!(join_path("Models/Survivors", "Survivor_Gambler", "mdl"), "models/survivors/survivor_gambler.mdl");
        assert_eq!(join_path("scripts", "readme", " "), "scripts/readme");
    }
}
