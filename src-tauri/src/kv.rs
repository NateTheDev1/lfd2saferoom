#[derive(Debug, Clone)]
pub enum Kv {
    Str(String),
    Obj(Vec<(String, Kv)>),
}

impl Kv {
    pub fn get(&self, key: &str) -> Option<&Kv> {
        self.entries()
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v)
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Kv::as_str)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Kv::Str(s) => Some(s),
            Kv::Obj(_) => None,
        }
    }

    pub fn entries(&self) -> &[(String, Kv)] {
        match self {
            Kv::Obj(items) => items,
            Kv::Str(_) => &[],
        }
    }
}

enum Tok {
    Open,
    Close,
    Str { text: String, quoted: bool },
}

fn tokenize(src: &str) -> Vec<Tok> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '{' {
            out.push(Tok::Open);
            i += 1;
        } else if c == '}' {
            out.push(Tok::Close);
            i += 1;
        } else if c == '"' {
            i += 1;
            let mut text = String::new();
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && chars.get(i + 1) == Some(&'"') {
                    i += 1;
                }
                text.push(chars[i]);
                i += 1;
            }
            i += 1;
            out.push(Tok::Str { text, quoted: true });
        } else {
            let mut text = String::new();
            while i < chars.len() && !chars[i].is_whitespace() && !matches!(chars[i], '{' | '}' | '"') {
                text.push(chars[i]);
                i += 1;
            }
            out.push(Tok::Str { text, quoted: false });
        }
    }
    out
}

fn is_conditional(tok: &Tok) -> bool {
    matches!(tok, Tok::Str { text, quoted: false } if text.starts_with('['))
}

fn parse_obj(toks: &[Tok], pos: &mut usize) -> Vec<(String, Kv)> {
    let mut items = Vec::new();
    while *pos < toks.len() {
        match &toks[*pos] {
            Tok::Close => {
                *pos += 1;
                break;
            }
            Tok::Open => {
                *pos += 1;
                parse_obj(toks, pos);
            }
            tok if is_conditional(tok) => *pos += 1,
            Tok::Str { text: key, .. } => {
                let key = key.clone();
                *pos += 1;
                while toks.get(*pos).is_some_and(is_conditional) {
                    *pos += 1;
                }
                match toks.get(*pos) {
                    Some(Tok::Open) => {
                        *pos += 1;
                        items.push((key, Kv::Obj(parse_obj(toks, pos))));
                    }
                    Some(Tok::Str { text, .. }) => {
                        items.push((key, Kv::Str(text.clone())));
                        *pos += 1;
                    }
                    _ => {}
                }
            }
        }
    }
    items
}

pub fn parse(src: &str) -> Kv {
    let toks = tokenize(src.trim_start_matches('\u{feff}'));
    let mut pos = 0;
    let mut items = Vec::new();
    while pos < toks.len() {
        items.extend(parse_obj(&toks, &mut pos));
    }
    Kv::Obj(items)
}

pub fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_addonlist() {
        let kv = parse("\"AddonList\"\n{\n\t\"workshop\\123.vpk\"\t\t\"1\"\n\t\"local.vpk\" \"0\"\n}\n");
        let list = kv.get("addonlist").unwrap();
        assert_eq!(list.entries().len(), 2);
        assert_eq!(list.get_str("workshop\\123.vpk"), Some("1"));
        assert_eq!(list.get_str("local.vpk"), Some("0"));
    }

    #[test]
    fn handles_unquoted_comments_and_brackets() {
        let kv = parse("AddonInfo\n{\n // note\n addontitle \"[WIP] Cool \\\"Mod\\\"\"\n addonversion 1.2 [$WIN32]\n}");
        let info = kv.get("AddonInfo").unwrap();
        assert_eq!(info.get_str("addontitle"), Some("[WIP] Cool \"Mod\""));
        assert_eq!(info.get_str("addonversion"), Some("1.2"));
    }
}
