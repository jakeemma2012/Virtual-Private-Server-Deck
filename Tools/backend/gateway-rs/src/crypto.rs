//! Mã hoá mật khẩu / khoá riêng SSH trước khi ghi vào SQLite.
//!
//! Bản Java lưu `sshPassword` dạng plaintext: ai copy được file DB là có root
//! của toàn bộ VPS. Ở đây mỗi giá trị được bọc AES-256-GCM với nonce ngẫu nhiên,
//! khoá nằm ở biến môi trường `JAKE_SECRET_KEY` (không nằm cùng file DB).
//!
//! Định dạng lưu: `v1:<base64(nonce[12] || ciphertext || tag[16])>`
//! Giá trị không có tiền tố `v1:` được coi là plaintext cũ và vẫn đọc được,
//! để migrate từ H2 không mất dữ liệu; lần ghi kế tiếp sẽ mã hoá lại.

use aes_gcm::aead::{Aead, Generate, KeyInit, Nonce};
use aes_gcm::Aes256Gcm;
use anyhow::{Context, Result, bail};
use base64::Engine;

const PREFIX: &str = "v1:";
const NONCE_LEN: usize = 12;

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[derive(Clone)]
pub struct Secrets {
    cipher: Aes256Gcm,
}

impl Secrets {
    pub fn new(key: &[u8; 32]) -> Self {
        Self {
            // new_from_slice chỉ fail khi độ dài khác 32; Config đã ép [u8; 32].
            cipher: Aes256Gcm::new_from_slice(key).expect("khoá AES phải đúng 32 byte"),
        }
    }

    /// Mã hoá. `None`/chuỗi rỗng giữ nguyên `None` để không lưu rác vào DB.
    pub fn seal(&self, plain: Option<&str>) -> Result<Option<String>> {
        let Some(plain) = plain.filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        let nonce = Nonce::<Aes256Gcm>::generate();
        let ct = self
            .cipher
            .encrypt(&nonce, plain.as_bytes())
            .map_err(|e| anyhow::anyhow!("mã hoá thất bại: {e}"))?;

        let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ct);
        Ok(Some(format!("{PREFIX}{}", b64().encode(blob))))
    }

    /// Giải mã. Giá trị chưa có tiền tố `v1:` được trả về nguyên văn (dữ liệu
    /// cũ từ H2) để lần migrate đầu tiên không làm mất mật khẩu.
    pub fn open(&self, stored: Option<&str>) -> Result<Option<String>> {
        let Some(stored) = stored.filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        let Some(b64_part) = stored.strip_prefix(PREFIX) else {
            return Ok(Some(stored.to_string()));
        };
        let blob = b64()
            .decode(b64_part)
            .context("giá trị mã hoá không phải base64 hợp lệ")?;
        if blob.len() <= NONCE_LEN {
            bail!("giá trị mã hoá quá ngắn, có thể file DB đã hỏng");
        }
        let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
        let nonce = Nonce::<Aes256Gcm>::try_from(nonce_bytes)
            .map_err(|_| anyhow::anyhow!("nonce không đúng {NONCE_LEN} byte"))?;
        let plain = self
            .cipher
            .decrypt(&nonce, ct)
            .map_err(|_| {
                anyhow::anyhow!(
                    "giải mã thất bại — JAKE_SECRET_KEY không khớp với khoá đã dùng để ghi DB"
                )
            })?;
        Ok(Some(String::from_utf8(plain).context("plaintext không phải UTF-8")?))
    }

    /// `true` nếu giá trị đang nằm ở dạng plaintext cũ, cần mã hoá lại.
    pub fn is_legacy_plaintext(stored: Option<&str>) -> bool {
        stored
            .filter(|s| !s.is_empty())
            .is_some_and(|s| !s.starts_with(PREFIX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secrets() -> Secrets {
        Secrets::new(&[7u8; 32])
    }

    #[test]
    fn seal_then_open_roundtrip() {
        let s = secrets();
        let sealed = s.seal(Some("mật khẩu root ê ộ ữ")).unwrap().unwrap();
        assert!(sealed.starts_with(PREFIX), "phải có tiền tố phiên bản");
        assert!(!sealed.contains("mật khẩu"), "plaintext không được lộ");
        assert_eq!(
            s.open(Some(&sealed)).unwrap().as_deref(),
            Some("mật khẩu root ê ộ ữ")
        );
    }

    #[test]
    fn nonce_is_random_so_same_input_differs() {
        let s = secrets();
        let a = s.seal(Some("same")).unwrap().unwrap();
        let b = s.seal(Some("same")).unwrap().unwrap();
        assert_ne!(a, b, "nonce lặp lại sẽ phá vỡ GCM");
    }

    #[test]
    fn legacy_plaintext_still_readable() {
        let s = secrets();
        assert_eq!(s.open(Some("plain-tu-h2")).unwrap().as_deref(), Some("plain-tu-h2"));
        assert!(Secrets::is_legacy_plaintext(Some("plain-tu-h2")));
        let sealed = s.seal(Some("x")).unwrap().unwrap();
        assert!(!Secrets::is_legacy_plaintext(Some(&sealed)));
    }

    #[test]
    fn wrong_key_fails_loudly() {
        let sealed = secrets().seal(Some("bi-mat")).unwrap().unwrap();
        let other = Secrets::new(&[9u8; 32]);
        assert!(other.open(Some(&sealed)).is_err(), "khoá sai phải báo lỗi, không trả rác");
    }

    #[test]
    fn empty_and_none_stay_none() {
        let s = secrets();
        assert!(s.seal(None).unwrap().is_none());
        assert!(s.seal(Some("")).unwrap().is_none());
        assert!(s.open(Some("")).unwrap().is_none());
    }
}
