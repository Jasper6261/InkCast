//! 授权（v0.8.6 预留接口）：激活码输入 + 功能解锁查询。
//!
//! 现状：`ENFORCE = false`——不限制任何功能，开发和内测期间全部可用；界面上已经能输入激活码、查看授权状态。
//! 正式收费前要做的事（见 PRODUCT_REQUIREMENTS.md E 节）：
//!   1. 把 `DevChecksumVerifier` 换成数字签名校验（激活码由服务器私钥签名，程序内置公钥验证）。
//!      需要引入签名库（如 ed25519），按安全规则先审查、锁定版本。
//!   2. 微软商店版改走商店授权（`Channel::Store`，通过 Windows.Services.Store 查询是否已购买）。
//!   3. 把 `ENFORCE` 改为 true，并确定免费版保留哪些功能（`FREE_FEATURES`）。
//!
//! 激活信息保存在数据目录 `data\license.json`，只含激活码和激活时间，不含个人信息。

use serde::{Deserialize, Serialize};

/// 是否按授权限制功能。false：全部功能可用（当前）
pub const ENFORCE: bool = false;

/// 全部功能（前端用这些名字查询是否解锁）
pub const ALL_FEATURES: &[&str] = &["write", "brushes", "brush_studio", "screen_annotation", "pc_tools", "export", "languages"];
/// 未激活时仍可用的功能（ENFORCE = true 时生效）
pub const FREE_FEATURES: &[&str] = &["write", "brushes", "languages"];

/// 校验激活码的方式；正式版替换实现即可，命令和界面不用改
pub trait Verifier {
    fn name(&self) -> &'static str;
    /// 通过返回套餐名（如 "pro"），失败返回给用户看的原因
    fn verify(&self, code: &str) -> Result<String, String>;
}

/// 开发用校验：格式 INK-XXXXX-XXXXX-XXXXX-XXXXX，最后一组是前三组的校验码。
/// 只用于联调激活流程，不能防伪造——正式收费前必须换成签名校验。
pub struct DevChecksumVerifier;

const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32（去掉 I L O U，避免看错）

fn fnv1a(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in data { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    h
}

fn check_group(body: &str) -> String {
    let mut h = fnv1a(format!("INKCAST-DEV:{}", body).as_bytes());
    let mut out = String::new();
    for _ in 0..5 { out.push(ALPHABET[(h & 31) as usize] as char); h >>= 5; }
    out
}

/// 规范化：去空格、转大写、全角横线转半角；不合格式返回 None
pub fn normalize(code: &str) -> Option<String> {
    let s: String = code.trim().chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c { '－' | '—' | '–' => '-', c => c.to_ascii_uppercase() })
        .collect();
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 || parts[0] != "INK" { return None; }
    if !parts[1..].iter().all(|p| p.len() == 5 && p.bytes().all(|b| ALPHABET.contains(&b))) { return None; }
    Some(s)
}

impl Verifier for DevChecksumVerifier {
    fn name(&self) -> &'static str { "dev-checksum" }
    fn verify(&self, code: &str) -> Result<String, String> {
        let code = normalize(code).ok_or("激活码格式不对：应为 INK-XXXXX-XXXXX-XXXXX-XXXXX")?;
        let parts: Vec<&str> = code.split('-').collect();
        let body = format!("{}-{}-{}", parts[1], parts[2], parts[3]);
        if check_group(&body) != parts[4] { return Err("激活码无效，请核对后重新输入".into()); }
        Ok("pro".into())
    }
}

/// 生成一个开发测试用激活码（测试和 tools/gen_test_code.py 用；正式签名方案上线后废弃）
#[cfg(test)]
pub fn make_dev_code(body3: &str) -> String {
    format!("INK-{}-{}", body3, check_group(body3))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub code: String,
    pub plan: String,
    pub activated_at: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "free"（未激活）| "active"（已激活）
    pub state: String,
    /// 是否在限制功能（ENFORCE）
    pub enforced: bool,
    pub plan: Option<String>,
    /// 激活码只显示末尾一组，避免截图泄露
    pub code_hint: Option<String>,
    pub activated_at: Option<u64>,
    /// 授权渠道："code"（激活码）；预留 "store"（微软商店）
    pub channel: String,
    pub verifier: String,
    /// 当前可用的功能
    pub features: Vec<String>,
}

pub fn status(stored: Option<&Stored>, verifier: &dyn Verifier) -> Status {
    let active = stored.is_some();
    let features: Vec<String> = if !ENFORCE || active { ALL_FEATURES } else { FREE_FEATURES }
        .iter().map(|s| s.to_string()).collect();
    Status {
        state: if active { "active" } else { "free" }.into(),
        enforced: ENFORCE,
        plan: stored.map(|s| s.plan.clone()),
        code_hint: stored.map(|s| format!("INK-…-{}", s.code.rsplit('-').next().unwrap_or(""))),
        activated_at: stored.map(|s| s.activated_at),
        channel: "code".into(),
        verifier: verifier.name().into(),
        features,
    }
}

pub fn load(path: &std::path::Path, verifier: &dyn Verifier) -> Option<Stored> {
    let text = std::fs::read_to_string(path).ok()?;
    if text.len() > 4096 { return None; }
    let s: Stored = serde_json::from_str(&text).ok()?;
    // 每次读取都重新校验，手改文件不能绕过
    verifier.verify(&s.code).ok()?;
    Some(s)
}

pub fn activate(path: &std::path::Path, verifier: &dyn Verifier, code: &str, now: u64) -> Result<Stored, String> {
    let plan = verifier.verify(code)?;
    let stored = Stored { code: normalize(code).unwrap_or_default(), plan, activated_at: now };
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("无法保存激活信息：{}", e))?; }
    std::fs::write(path, serde_json::to_string(&stored).map_err(|e| e.to_string())?).map_err(|e| format!("无法保存激活信息：{}", e))?;
    Ok(stored)
}

pub fn deactivate(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("无法移除激活信息：{}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_codes_verify_and_reject_tampering() {
        let v = DevChecksumVerifier;
        let code = make_dev_code("AB12C-DE34F-GH56J");
        assert_eq!(v.verify(&code), Ok("pro".to_string()));
        // 与 tools/gen_test_code.py 生成的一致
        assert_eq!(code, "INK-AB12C-DE34F-GH56J-HFB0G");
        // 小写、空格、全角横线都能接受
        assert!(v.verify(&format!("  {}  ", code.to_lowercase().replace('-', "－"))).is_ok());
        // 改一个字符就失败
        let mut bad = code.clone().into_bytes();
        let i = 5; bad[i] = if bad[i] == b'A' { b'B' } else { b'A' };
        assert!(v.verify(&String::from_utf8(bad).unwrap()).is_err());
        assert!(v.verify("INK-1234").is_err());
        assert!(v.verify("XYZ-AB12C-DE34F-GH56J-00000").is_err());
        assert!(v.verify("INK-AB12C-DE34F-GH56J-0000I").is_err()); // I 不在字母表里
    }

    #[test]
    fn activate_load_status_deactivate() {
        let dir = std::env::temp_dir().join(format!("inkcast-lic-{}", std::process::id()));
        let path = dir.join("data").join("license.json");
        let v = DevChecksumVerifier;
        assert!(load(&path, &v).is_none());
        let st = status(None, &v);
        assert_eq!(st.state, "free");
        assert_eq!(st.features.len(), if ENFORCE { FREE_FEATURES.len() } else { ALL_FEATURES.len() });
        assert!(activate(&path, &v, "INK-AAAAA-BBBBB-CCCCC-DDDDD", 1).is_err());
        assert!(!path.exists(), "invalid codes are not saved");
        let code = make_dev_code("Q1W2E-R3T4Y-Z5P6A");
        let stored = activate(&path, &v, &code, 42).unwrap();
        assert_eq!(load(&path, &v), Some(stored.clone()));
        let st = status(Some(&stored), &v);
        assert_eq!((st.state.as_str(), st.plan.as_deref(), st.features.len()), ("active", Some("pro"), ALL_FEATURES.len()));
        assert!(st.code_hint.unwrap().ends_with(code.rsplit('-').next().unwrap()));
        // 手改文件里的激活码：读取时重新校验，不算激活
        std::fs::write(&path, r#"{"code":"INK-AAAAA-BBBBB-CCCCC-DDDDD","plan":"pro","activatedAt":1}"#).unwrap();
        assert!(load(&path, &v).is_none());
        deactivate(&path).unwrap();
        deactivate(&path).unwrap(); // 重复移除不报错
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
