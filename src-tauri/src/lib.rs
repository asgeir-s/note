use chrono::Local;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::State;
use uuid::Uuid;

const INDEX_FILE_NAME: &str = ".dump-index.json";

#[derive(Default)]
struct AppState {
    notes_dir: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteSummary {
    id: String,
    path: String,
    title: String,
    created: String,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexFile {
    version: u8,
    notes: BTreeMap<String, NoteSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveNoteRequest {
    content: String,
    existing_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveNoteResponse {
    note: NoteSummary,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppDataResponse {
    notes_dir: String,
    recent: Vec<NoteSummary>,
    tags: Vec<String>,
}

#[derive(Debug, Clone)]
struct ParsedFrontmatter {
    id: Option<String>,
    created: Option<String>,
    tags: Vec<String>,
}

#[tauri::command]
fn get_app_data(
    state: State<'_, AppState>,
    notes_dir: Option<String>,
) -> Result<AppDataResponse, String> {
    let notes_dir = ensure_notes_dir(&state, notes_dir)?;
    let index = rebuild_index(&notes_dir)?;
    Ok(AppDataResponse {
        notes_dir: notes_dir.to_string_lossy().to_string(),
        recent: sorted_notes(&index, Some(10)),
        tags: collect_tags(&index),
    })
}

#[tauri::command]
fn list_recent_notes(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<NoteSummary>, String> {
    let notes_dir = ensure_notes_dir(&state, None)?;
    let index = rebuild_index(&notes_dir)?;
    Ok(sorted_notes(&index, limit))
}

#[tauri::command]
fn search_notes(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NoteSummary>, String> {
    let notes_dir = ensure_notes_dir(&state, None)?;
    let index = rebuild_index(&notes_dir)?;
    let resolved_limit = limit.unwrap_or(6);

    if query.trim().is_empty() {
        return Ok(sorted_notes(&index, Some(resolved_limit)));
    }

    if let Ok(paths) = qmd_search_paths(&notes_dir, &query) {
        if !paths.is_empty() {
            let mut matches = Vec::new();
            for file_name in paths {
                if let Some(note) = index.notes.values().find(|n| n.path == file_name) {
                    matches.push(note.clone());
                }
            }
            matches.truncate(resolved_limit);
            return Ok(matches);
        }
    }

    let query_lc = query.to_lowercase();
    let mut fallback = Vec::new();
    for entry in index.notes.values() {
        let note_path = notes_dir.join(&entry.path);
        if let Ok(content) = fs::read_to_string(&note_path) {
            if content.to_lowercase().contains(&query_lc) {
                fallback.push(entry.clone());
            }
        }
    }
    fallback.truncate(resolved_limit);
    Ok(fallback)
}

#[tauri::command]
fn open_note(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let notes_dir = ensure_notes_dir(&state, None)?;
    let note_path = resolve_note_path(&notes_dir, &path)?;
    fs::read_to_string(note_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_note(
    state: State<'_, AppState>,
    request: SaveNoteRequest,
) -> Result<SaveNoteResponse, String> {
    let notes_dir = ensure_notes_dir(&state, None)?;
    let parsed = split_frontmatter(&request.content);
    let body = parsed.1.trim().to_string();
    if body.is_empty() {
        return Err("Cannot save an empty note".to_string());
    }

    let mut metadata = parse_frontmatter(parsed.0.unwrap_or_default());
    if metadata.id.is_none() {
        metadata.id = Some(Uuid::new_v4().to_string());
    }
    if metadata.created.is_none() {
        metadata.created = Some(Local::now().to_rfc3339());
    }

    let title = extract_title(&body);
    let file_name = if let Some(existing) = request.existing_path {
        validate_note_file_name(&existing)?;
        existing
    } else {
        format!(
            "{}-{}.md",
            Local::now().format("%Y%m%d%H%M%S"),
            slugify(&title)
        )
    };

    let normalized = build_markdown(&metadata, &body);
    let target_path = notes_dir.join(&file_name);
    fs::write(&target_path, normalized.clone()).map_err(|e| e.to_string())?;

    let index = rebuild_index(&notes_dir)?;
    let id = metadata.id.ok_or_else(|| "Missing note id".to_string())?;
    let note = index
        .notes
        .get(&id)
        .cloned()
        .ok_or_else(|| "Saved note missing from index".to_string())?;

    Ok(SaveNoteResponse {
        note,
        content: normalized,
    })
}

#[tauri::command]
fn list_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let notes_dir = ensure_notes_dir(&state, None)?;
    let index = rebuild_index(&notes_dir)?;
    Ok(collect_tags(&index))
}

fn ensure_notes_dir(
    state: &State<'_, AppState>,
    requested: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(path) = requested {
        let dir = PathBuf::from(path);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        *state
            .notes_dir
            .lock()
            .map_err(|_| "Notes dir lock poisoned".to_string())? = Some(dir.clone());
        return Ok(dir);
    }

    if let Some(existing) = state
        .notes_dir
        .lock()
        .map_err(|_| "Notes dir lock poisoned".to_string())?
        .clone()
    {
        fs::create_dir_all(&existing).map_err(|e| e.to_string())?;
        return Ok(existing);
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let dir = PathBuf::from(home).join("dump");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    *state
        .notes_dir
        .lock()
        .map_err(|_| "Notes dir lock poisoned".to_string())? = Some(dir.clone());
    Ok(dir)
}

fn rebuild_index(notes_dir: &Path) -> Result<IndexFile, String> {
    let mut notes = BTreeMap::new();
    let entries = fs::read_dir(notes_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let fallback_created = fs::metadata(&path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .map(|time| chrono::DateTime::<Local>::from(time).to_rfc3339())
            .unwrap_or_default();
        let parsed = split_frontmatter(&content);
        let fm = parse_frontmatter(parsed.0.unwrap_or_default());
        let id = match fm.id {
            Some(id) => id,
            None => continue,
        };
        let file_name = match path.file_name().and_then(|x| x.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        notes.insert(
            id.clone(),
            NoteSummary {
                id,
                path: file_name,
                title: extract_title(parsed.1),
                created: fm.created.unwrap_or(fallback_created),
                tags: fm.tags,
            },
        );
    }

    let index = IndexFile { version: 1, notes };
    let index_path = notes_dir.join(INDEX_FILE_NAME);
    let json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    fs::write(index_path, json).map_err(|e| e.to_string())?;
    Ok(index)
}

fn sorted_notes(index: &IndexFile, limit: Option<usize>) -> Vec<NoteSummary> {
    let mut notes: Vec<NoteSummary> = index.notes.values().cloned().collect();
    notes.sort_by(|a, b| b.created.cmp(&a.created));
    notes.truncate(limit.unwrap_or(10));
    notes
}

fn collect_tags(index: &IndexFile) -> Vec<String> {
    index
        .notes
        .values()
        .flat_map(|n| n.tags.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn qmd_search_paths(notes_dir: &Path, query: &str) -> Result<Vec<String>, String> {
    let output = Command::new("qmd")
        .arg("search")
        .arg(query)
        .arg(notes_dir)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let candidate = line.trim();
            if candidate.ends_with(".md") {
                Path::new(candidate)
                    .file_name()
                    .and_then(|x| x.to_str())
                    .map(|x| x.to_string())
            } else {
                None
            }
        })
        .collect())
}

fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    if !content.starts_with("---\n") {
        return (None, content);
    }
    let rest = &content[4..];
    if let Some(end) = rest.find("\n---\n") {
        let fm = &rest[..end];
        let body = &rest[(end + 5)..];
        return (Some(fm), body);
    }
    (None, content)
}

fn parse_frontmatter(frontmatter: &str) -> ParsedFrontmatter {
    let mut id = None;
    let mut created = None;
    let mut tags = Vec::new();

    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("id:") {
            let v = value.trim();
            if !v.is_empty() {
                id = Some(v.to_string());
            }
        } else if let Some(value) = trimmed.strip_prefix("created:") {
            let v = value.trim();
            if !v.is_empty() {
                created = Some(v.to_string());
            }
        } else if let Some(value) = trimmed.strip_prefix("tags:") {
            tags = parse_inline_tags(value);
        }
    }

    ParsedFrontmatter { id, created, tags }
}

fn parse_inline_tags(tags_value: &str) -> Vec<String> {
    let value = tags_value.trim();
    if !(value.starts_with('[') && value.ends_with(']')) {
        return Vec::new();
    }
    value[1..value.len() - 1]
        .split(',')
        .filter_map(|tag| {
            let clean = tag.trim().trim_matches('"').trim_matches('\'').trim();
            if clean.is_empty() {
                None
            } else {
                Some(clean.to_string())
            }
        })
        .collect()
}

fn build_markdown(frontmatter: &ParsedFrontmatter, body: &str) -> String {
    let tags = if frontmatter.tags.is_empty() {
        "[]".to_string()
    } else {
        format!("[{}]", frontmatter.tags.join(", "))
    };
    format!(
        "---\nid: {}\ncreated: {}\ntags: {}\n---\n\n{}\n",
        frontmatter.id.as_deref().unwrap_or_default(),
        frontmatter.created.as_deref().unwrap_or_default(),
        tags,
        body.trim()
    )
}

fn extract_title(content: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("# ") {
            let t = title.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "untitled".to_string()
}

fn slugify(input: &str) -> String {
    let mut slug = String::new();
    let mut last_was_sep = false;
    for c in input.trim().chars().flat_map(|c| c.to_lowercase()) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            last_was_sep = false;
        } else if !last_was_sep {
            slug.push('_');
            last_was_sep = true;
        }
    }
    let slug = slug.trim_matches('_');
    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug.to_string()
    }
}

fn validate_note_file_name(file_name: &str) -> Result<(), String> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || !file_name.ends_with(".md")
    {
        return Err("Invalid note path".to_string());
    }
    Ok(())
}

fn resolve_note_path(notes_dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    validate_note_file_name(file_name)?;
    Ok(notes_dir.join(file_name))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_app_data,
            list_recent_notes,
            search_notes,
            open_note,
            save_note,
            list_tags
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
