use crate::domain::PitaError;
use crate::tree::remove_path_safe;
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub(crate) struct InstallJournal {
    paths: Vec<(PathBuf, Option<tempfile::TempDir>)>,
    seen: HashSet<PathBuf>,
    armed: bool,
}

impl InstallJournal {
    pub fn capture(&mut self, path: PathBuf) -> Result<(), PitaError> {
        let parent = path.parent().ok_or(PitaError::InvalidSkill)?;
        let dedup = fs::canonicalize(parent)
            .ok()
            .and_then(|parent| path.file_name().map(|name| parent.join(name)))
            .unwrap_or_else(|| path.clone());
        if !self.seen.insert(dedup) {
            return Ok(());
        }

        let backup = match fs::symlink_metadata(&path) {
            Ok(_) => {
                let temp = tempfile::Builder::new()
                    .prefix(".pita-install-")
                    .tempdir_in(parent)?;
                copy_entry(&path, &temp.path().join("original"))?;
                Some(temp)
            }
            Err(err) if err.kind() == ErrorKind::NotFound => None,
            Err(err) => return Err(err.into()),
        };
        self.paths.push((path, backup));
        Ok(())
    }

    pub fn arm(&mut self) {
        self.armed = true;
    }

    pub fn commit(mut self) {
        self.armed = false;
    }
}

impl Drop for InstallJournal {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        for (path, backup) in self.paths.drain(..).rev() {
            let result = remove_path_safe(&path).and_then(|()| {
                if let Some(backup) = &backup {
                    fs::rename(backup.path().join("original"), &path)?;
                }
                Ok(())
            });
            if let Err(error) = result {
                let saved = backup.map(tempfile::TempDir::keep);
                eprintln!("Pita install rollback failed at {path:?}: {error}. Backup: {saved:?}");
            }
        }
    }
}

fn copy_entry(source: &Path, dest: &Path) -> Result<(), PitaError> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_symlink() {
        let target = fs::read_link(source)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, dest)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt;
            if metadata.file_type().is_symlink_dir() {
                std::os::windows::fs::symlink_dir(target, dest)?;
            } else {
                std::os::windows::fs::symlink_file(target, dest)?;
            }
        }
    } else if metadata.is_dir() {
        fs::create_dir(dest)?;
        for child in fs::read_dir(source)? {
            let child = child?;
            copy_entry(&child.path(), &dest.join(child.file_name()))?;
        }
        fs::set_permissions(dest, metadata.permissions())?;
    } else if metadata.is_file() {
        fs::copy(source, dest)?;
    } else {
        return Err(PitaError::Internal("contentConflict".into()));
    }
    Ok(())
}
