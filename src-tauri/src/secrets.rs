use crate::domain::PitaError;

const SERVICE: &str = "dev.pita.skills";

pub fn store_secret(key: &str, value: &str) -> Result<(), PitaError> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
        if entry.set_password(value).is_ok() {
            return Ok(());
        }
    }
    // Graceful no-op in headless CI/Linux without Secret Service daemon
    Ok(())
}

pub fn load_secret(key: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, key)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

pub fn delete_secret(key: &str) {
    if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
        let _ = entry.delete_credential();
    }
}

pub fn set_remote_token(url: &str, token: &str) -> Result<(), PitaError> {
    store_secret(&format!("remote:{}", url.trim()), token)
}

pub fn get_remote_token(url: &str) -> Option<String> {
    load_secret(&format!("remote:{}", url.trim()))
}

pub fn delete_remote_token(url: &str) {
    delete_secret(&format!("remote:{}", url.trim()));
}
