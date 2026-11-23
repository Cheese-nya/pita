use crate::domain::{
    Binding, PitaError, Preset, ProjectWorkspace, RemoteConfig, Skill, Snapshot, Workspace,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::Path;

pub struct PitaDb {
    conn: Connection,
}

impl PitaDb {
    pub fn open(db_path: &Path) -> Result<Self, PitaError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS skills (
                id TEXT PRIMARY KEY,
                position INTEGER NOT NULL,
                data_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                position INTEGER NOT NULL,
                data_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS presets (
                id TEXT PRIMARY KEY,
                position INTEGER NOT NULL,
                data_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                preset_id TEXT NOT NULL,
                target_key TEXT NOT NULL,
                data_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY,
                position INTEGER NOT NULL,
                skill_id TEXT NOT NULL,
                at TEXT NOT NULL,
                data_json TEXT NOT NULL
            );
            ",
        )?;
        Ok(Self { conn })
    }

    fn get_meta(&self, key: &str) -> Result<Option<String>, PitaError> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(PitaError::from)
    }

    fn set_meta(tx: &rusqlite::Transaction<'_>, key: &str, value: &str) -> Result<(), PitaError> {
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn load_workspace(&self, root_display: &str) -> Result<Workspace, PitaError> {
        let mut skills = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT data_json FROM skills ORDER BY position ASC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for row in rows {
                let s: Skill = serde_json::from_str(&row?)?;
                skills.push(s);
            }
        }

        let mut projects = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT data_json FROM projects ORDER BY position ASC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for row in rows {
                let p: ProjectWorkspace = serde_json::from_str(&row?)?;
                projects.push(p);
            }
        }

        let mut presets = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT data_json FROM presets ORDER BY position ASC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for row in rows {
                let p: Preset = serde_json::from_str(&row?)?;
                presets.push(p);
            }
        }

        let mut bindings = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT data_json FROM bindings ORDER BY id ASC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for row in rows {
                let b: Binding = serde_json::from_str(&row?)?;
                bindings.push(b);
            }
        }

        let mut snapshots = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT data_json FROM snapshots ORDER BY position ASC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for row in rows {
                let s: Snapshot = serde_json::from_str(&row?)?;
                snapshots.push(s);
            }
        }

        let checked_at = self.get_meta("checked_at")?.unwrap_or_default();
        let scanned_at = self.get_meta("scanned_at")?.unwrap_or_default();
        let remote: Option<RemoteConfig> = match self.get_meta("remote_json")? {
            Some(raw) if !raw.trim().is_empty() && raw != "null" => {
                Some(serde_json::from_str(&raw)?)
            }
            _ => None,
        };

        Ok(Workspace {
            skills,
            projects,
            presets,
            bindings,
            snapshots,
            checked_at,
            scanned_at,
            root: root_display.to_string(),
            remote,
        })
    }

    pub fn save_workspace(&mut self, ws: &Workspace) -> Result<(), PitaError> {
        self.save_workspace_with_undo(ws, None)
    }

    pub(crate) fn save_workspace_with_undo(
        &mut self,
        ws: &Workspace,
        undo: Option<&Workspace>,
    ) -> Result<(), PitaError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM skills", [])?;
        tx.execute("DELETE FROM projects", [])?;
        tx.execute("DELETE FROM presets", [])?;
        tx.execute("DELETE FROM bindings", [])?;
        tx.execute("DELETE FROM snapshots", [])?;

        for (pos, skill) in ws.skills.iter().enumerate() {
            let json = serde_json::to_string(skill)?;
            tx.execute(
                "INSERT INTO skills (id, position, data_json) VALUES (?1, ?2, ?3)",
                params![skill.id, pos as i64, json],
            )?;
        }

        for (pos, proj) in ws.projects.iter().enumerate() {
            let json = serde_json::to_string(proj)?;
            tx.execute(
                "INSERT INTO projects (id, position, data_json) VALUES (?1, ?2, ?3)",
                params![proj.id, pos as i64, json],
            )?;
        }

        for (pos, preset) in ws.presets.iter().enumerate() {
            let json = serde_json::to_string(preset)?;
            tx.execute(
                "INSERT INTO presets (id, position, data_json) VALUES (?1, ?2, ?3)",
                params![preset.id, pos as i64, json],
            )?;
        }

        for binding in &ws.bindings {
            let json = serde_json::to_string(binding)?;
            tx.execute(
                "INSERT INTO bindings (preset_id, target_key, data_json) VALUES (?1, ?2, ?3)",
                params![binding.preset_id, binding.target.key(), json],
            )?;
        }

        for (pos, snap) in ws.snapshots.iter().enumerate() {
            let json = serde_json::to_string(snap)?;
            tx.execute(
                "INSERT INTO snapshots (id, position, skill_id, at, data_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![snap.id, pos as i64, snap.skill_id, snap.at, json],
            )?;
        }

        Self::set_meta(&tx, "checked_at", &ws.checked_at)?;
        Self::set_meta(&tx, "scanned_at", &ws.scanned_at)?;
        let remote_json = match &ws.remote {
            Some(r) => serde_json::to_string(r)?,
            None => "null".to_string(),
        };
        Self::set_meta(&tx, "remote_json", &remote_json)?;
        if let Some(undo) = undo {
            Self::set_meta(&tx, "undo_workspace_json", &serde_json::to_string(undo)?)?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn save_undo(&mut self, ws: &Workspace) -> Result<(), PitaError> {
        let json = serde_json::to_string(ws)?;
        let tx = self.conn.transaction()?;
        Self::set_meta(&tx, "undo_workspace_json", &json)?;
        tx.commit()?;
        Ok(())
    }

    pub fn take_undo(&mut self) -> Result<Option<Workspace>, PitaError> {
        let Some(raw) = self.get_meta("undo_workspace_json")? else {
            return Ok(None);
        };
        if raw.trim().is_empty() || raw == "null" {
            return Ok(None);
        }
        let ws: Workspace = serde_json::from_str(&raw)?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM meta WHERE key = 'undo_workspace_json'", [])?;
        tx.commit()?;
        Ok(Some(ws))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SkillSource;
    use crate::tree::{encode_bytes as encode_b64, make_skill};
    use std::collections::BTreeMap;

    #[test]
    fn sqlite_roundtrip_and_undo() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("pita.db");
        let mut db = PitaDb::open(&db_path).unwrap();

        let mut files = BTreeMap::new();
        files.insert(
            "SKILL.md".into(),
            encode_b64(b"---\nname: alpha-tool\ndescription: Test skill.\n---\n# Alpha\n"),
        );
        let skill = make_skill(files, SkillSource::Local { origin_path: None }, None).unwrap();
        let ws = Workspace {
            skills: vec![skill],
            projects: vec![],
            presets: vec![],
            bindings: vec![],
            snapshots: vec![],
            checked_at: "2026-01-01T00:00:00Z".into(),
            scanned_at: "2026-01-01T00:00:00Z".into(),
            root: "~/.pita/".into(),
            remote: None,
        };
        db.save_workspace(&ws).unwrap();
        db.save_undo(&ws).unwrap();

        let loaded = db.load_workspace("~/.pita/").unwrap();
        assert_eq!(loaded.skills.len(), 1);
        assert_eq!(loaded.skills[0].id, "alpha-tool");

        let undone = db.take_undo().unwrap();
        assert!(undone.is_some());
        assert!(db.take_undo().unwrap().is_none());
    }
}
