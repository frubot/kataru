//! 常駐記憶（core memory）。
//!
//! キャラクターごとに1枚だけ持つ短い記憶で、検索に関係なく毎回プロンプトへ入る。
//! 「ユーザーについて」「関係」「自分の今」の3つの見出しに、1行1項目で書く。
//! 行には `u1` / `r2` / `s3` のような ID を振り、AI は ID を指定して差分で更新する。
//! 一度使った番号は使い回さない。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 常駐記憶全体の文字数の上限。
pub const CORE_MEMORY_MAX_CHARS: usize = 1000;
/// 1行の文字数の上限。
pub const CORE_MEMORY_ENTRY_MAX_CHARS: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoreMemorySection {
    /// {{user}} について（名前、呼び方、NG、大事な属性）。
    User,
    /// {{user}} との関係（今の関係、距離感、まだ果たしていない約束）。
    Relationship,
    /// キャラクター自身の今の状態（会話の中で変わったこと）。
    #[serde(rename = "self")]
    SelfState,
}

impl CoreMemorySection {
    pub const ALL: [Self; 3] = [Self::User, Self::Relationship, Self::SelfState];

    fn id_prefix(self) -> char {
        match self {
            Self::User => 'u',
            Self::Relationship => 'r',
            Self::SelfState => 's',
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Relationship => "relationship",
            Self::SelfState => "self",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "relationship" => Some(Self::Relationship),
            "self" => Some(Self::SelfState),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoreMemoryAuthor {
    #[default]
    User,
    Ai,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreMemoryEntry {
    /// 画面で新しく足した行は空。保存時に振る。
    #[serde(default)]
    pub id: String,
    pub section: CoreMemorySection,
    pub text: String,
    /// 固定した行は AI が変えられない。
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub author: CoreMemoryAuthor,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreMemory {
    pub character_id: String,
    /// 保存するたびに1つ増える。画面と裏の更新がぶつかったときの検出に使う。
    #[serde(default)]
    pub version: i64,
    /// 次に振る行の番号。
    #[serde(default = "first_id_number")]
    pub next_id: u64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub entries: Vec<CoreMemoryEntry>,
}

fn first_id_number() -> u64 {
    1
}

impl CoreMemory {
    pub fn empty(character_id: &str) -> Self {
        Self {
            character_id: character_id.to_owned(),
            version: 0,
            next_id: first_id_number(),
            updated_at: 0,
            entries: Vec::new(),
        }
    }

    pub fn char_count(&self) -> usize {
        self.entries
            .iter()
            .map(|entry| entry.text.chars().count())
            .sum()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn entry(&self, id: &str) -> Option<&CoreMemoryEntry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    fn allocate_id(&mut self, section: CoreMemorySection) -> String {
        let id = format!("{}{}", section.id_prefix(), self.next_id);
        self.next_id += 1;
        id
    }

    /// 見出しごとに並べ替える。見出しの中の順番は保つ。
    fn sort_by_section(&mut self) {
        self.entries.sort_by_key(|entry| {
            CoreMemorySection::ALL
                .iter()
                .position(|section| *section == entry.section)
        });
    }

    /// キャラクターの応答プロンプトに入れる文章。空なら `None`。
    pub fn render_for_character(&self, character_name: &str) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let mut text = String::new();
        for section in CoreMemorySection::ALL {
            let lines = self
                .entries
                .iter()
                .filter(|entry| entry.section == section)
                .map(|entry| format!("- {}", entry.text))
                .collect::<Vec<_>>();
            if lines.is_empty() {
                continue;
            }
            if !text.is_empty() {
                text.push('\n');
            }
            let heading = match section {
                CoreMemorySection::User => "About {{user}}".to_owned(),
                CoreMemorySection::Relationship => "Relationship with {{user}}".to_owned(),
                CoreMemorySection::SelfState => format!("{character_name}'s current state"),
            };
            text.push_str(&format!("[{heading}]\n{}\n", lines.join("\n")));
        }
        Some(text.trim_end().to_owned())
    }

    /// 更新用プロンプトに入れる、ID と固定の印つきの一覧。
    pub fn render_for_update(&self) -> String {
        let mut text = String::new();
        for section in CoreMemorySection::ALL {
            text.push_str(&format!("[{}]\n", section.as_str()));
            let mut any = false;
            for entry in self.entries.iter().filter(|entry| entry.section == section) {
                any = true;
                let locked = if entry.locked { " (locked)" } else { "" };
                text.push_str(&format!("{}{locked}: {}\n", entry.id, entry.text));
            }
            if !any {
                text.push_str("(none)\n");
            }
        }
        text.push_str(&format!(
            "\n{} / {} characters used",
            self.char_count(),
            CORE_MEMORY_MAX_CHARS
        ));
        text
    }
}

/// 画面から送られた常駐記憶を検証して、保存する形にする。
/// 新しい行に ID を振り、内容が変わった行は書いた人をユーザーにする。
pub fn normalize_user_edit(
    previous: Option<&CoreMemory>,
    submitted: CoreMemory,
    now: i64,
) -> AppResult<CoreMemory> {
    let character_id = submitted.character_id.trim().to_owned();
    if character_id.is_empty() {
        return Err(AppError::BadRequest(
            "常駐記憶の characterId がありません。".to_owned(),
        ));
    }
    let mut memory = CoreMemory {
        character_id,
        version: previous.map_or(0, |previous| previous.version) + 1,
        next_id: previous
            .map_or(first_id_number(), |previous| previous.next_id)
            .max(submitted.next_id)
            .max(next_id_after(&submitted.entries)),
        updated_at: now,
        entries: Vec::with_capacity(submitted.entries.len()),
    };
    let mut seen = HashSet::new();
    for entry in submitted.entries {
        let text = normalize_text(&entry.text);
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > CORE_MEMORY_ENTRY_MAX_CHARS {
            return Err(AppError::BadRequest(format!(
                "常駐記憶の1行は{CORE_MEMORY_ENTRY_MAX_CHARS}文字までです。"
            )));
        }
        let id_is_usable = is_valid_id(&entry.id, entry.section) && seen.insert(entry.id.clone());
        let id = if id_is_usable {
            entry.id
        } else {
            let id = memory.allocate_id(entry.section);
            seen.insert(id.clone());
            id
        };
        let unchanged = previous
            .and_then(|previous| previous.entry(&id))
            .filter(|old| old.text == text && old.section == entry.section);
        let (author, updated_at) = match unchanged {
            Some(old) => (old.author, old.updated_at),
            None => (CoreMemoryAuthor::User, now),
        };
        memory.entries.push(CoreMemoryEntry {
            id,
            section: entry.section,
            text,
            locked: entry.locked,
            author,
            updated_at,
        });
    }
    if memory.char_count() > CORE_MEMORY_MAX_CHARS {
        return Err(AppError::BadRequest(format!(
            "常駐記憶は全部で{CORE_MEMORY_MAX_CHARS}文字までです。"
        )));
    }
    memory.sort_by_section();
    Ok(memory)
}

fn is_valid_id(id: &str, section: CoreMemorySection) -> bool {
    let mut chars = id.chars();
    chars.next() == Some(section.id_prefix())
        && id.len() > 1
        && chars.all(|character| character.is_ascii_digit())
}

fn next_id_after(entries: &[CoreMemoryEntry]) -> u64 {
    entries
        .iter()
        .filter_map(|entry| entry.id.get(1..)?.parse::<u64>().ok())
        .max()
        .map_or(first_id_number(), |max| max + 1)
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// AI が出す差分の指示1つ。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoreMemoryOp {
    Add {
        section: CoreMemorySection,
        text: String,
    },
    Replace {
        id: String,
        text: String,
    },
    Remove {
        id: String,
    },
    /// 常駐記憶から外して、検索型の記憶へ移す。
    Demote {
        id: String,
    },
}

/// 適用できなかった指示と、その理由（AI へのやり直しの指示にも使う）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RejectedOp {
    pub op: CoreMemoryOp,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyOutcome {
    pub memory: CoreMemory,
    pub applied: usize,
    pub rejected: Vec<RejectedOp>,
    /// `demote` で外した行。検索型の記憶として保存する。
    pub demoted: Vec<CoreMemoryEntry>,
}

/// 差分の指示を適用する。問題のある指示はその指示だけ飛ばし、理由を返す。
///
/// 空きを作ってから足せるように、削除・移動 → 書き換え → 追加 の順に処理する。
pub fn apply_ops(memory: &CoreMemory, ops: Vec<CoreMemoryOp>, now: i64) -> ApplyOutcome {
    let mut next = memory.clone();
    let mut applied = 0;
    let mut rejected = Vec::new();
    let mut demoted = Vec::new();
    let mut touched = HashSet::new();

    let rank = |op: &CoreMemoryOp| match op {
        CoreMemoryOp::Remove { .. } | CoreMemoryOp::Demote { .. } => 0,
        CoreMemoryOp::Replace { .. } => 1,
        CoreMemoryOp::Add { .. } => 2,
    };
    let mut ordered = ops;
    ordered.sort_by_key(rank);

    for op in ordered {
        match check_op(&next, &op, &touched) {
            Err(reason) => rejected.push(RejectedOp { op, reason }),
            Ok(()) => {
                match &op {
                    CoreMemoryOp::Add { section, text } => {
                        let id = next.allocate_id(*section);
                        touched.insert(id.clone());
                        next.entries.push(CoreMemoryEntry {
                            id,
                            section: *section,
                            text: normalize_text(text),
                            locked: false,
                            author: CoreMemoryAuthor::Ai,
                            updated_at: now,
                        });
                    }
                    CoreMemoryOp::Replace { id, text } => {
                        touched.insert(id.clone());
                        if let Some(entry) = next.entries.iter_mut().find(|entry| entry.id == *id) {
                            entry.text = normalize_text(text);
                            entry.author = CoreMemoryAuthor::Ai;
                            entry.updated_at = now;
                        }
                    }
                    CoreMemoryOp::Remove { id } | CoreMemoryOp::Demote { id } => {
                        touched.insert(id.clone());
                        if let Some(index) = next.entries.iter().position(|entry| entry.id == *id) {
                            let entry = next.entries.remove(index);
                            if matches!(op, CoreMemoryOp::Demote { .. }) {
                                demoted.push(entry);
                            }
                        }
                    }
                }
                applied += 1;
            }
        }
    }
    if applied > 0 {
        next.version += 1;
        next.updated_at = now;
        next.sort_by_section();
    }
    ApplyOutcome {
        memory: next,
        applied,
        rejected,
        demoted,
    }
}

fn check_op(
    memory: &CoreMemory,
    op: &CoreMemoryOp,
    touched: &HashSet<String>,
) -> Result<(), String> {
    let check_target = |id: &str| -> Result<&CoreMemoryEntry, String> {
        if touched.contains(id) {
            return Err(format!("{id} はこの更新ですでに変更しています。"));
        }
        let entry = memory
            .entry(id)
            .ok_or_else(|| format!("{id} という行はありません。"))?;
        if entry.locked {
            return Err(format!("{id} はユーザーが固定した行なので変更できません。"));
        }
        Ok(entry)
    };
    let check_text = |text: &str, freed: usize| -> Result<(), String> {
        let text = normalize_text(text);
        let length = text.chars().count();
        if length == 0 {
            return Err("text が空です。".to_owned());
        }
        if length > CORE_MEMORY_ENTRY_MAX_CHARS {
            return Err(format!(
                "1行は{CORE_MEMORY_ENTRY_MAX_CHARS}文字までです（{length}文字）。"
            ));
        }
        let total = memory.char_count() - freed + length;
        if total > CORE_MEMORY_MAX_CHARS {
            return Err(format!(
                "適用すると{total}/{CORE_MEMORY_MAX_CHARS}文字になり、上限を超えます。"
            ));
        }
        Ok(())
    };
    match op {
        CoreMemoryOp::Add { text, .. } => {
            let normalized = normalize_text(text);
            if memory.entries.iter().any(|entry| entry.text == normalized) {
                return Err("同じ内容の行がすでにあります。".to_owned());
            }
            check_text(text, 0)
        }
        CoreMemoryOp::Replace { id, text } => {
            let entry = check_target(id)?;
            check_text(text, entry.text.chars().count())
        }
        CoreMemoryOp::Remove { id } | CoreMemoryOp::Demote { id } => check_target(id).map(|_| ()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, section: CoreMemorySection, text: &str) -> CoreMemoryEntry {
        CoreMemoryEntry {
            id: id.to_owned(),
            section,
            text: text.to_owned(),
            locked: false,
            author: CoreMemoryAuthor::Ai,
            updated_at: 1,
        }
    }

    fn sample() -> CoreMemory {
        CoreMemory {
            character_id: "c1".to_owned(),
            version: 3,
            next_id: 4,
            updated_at: 1,
            entries: vec![
                entry("u1", CoreMemorySection::User, "{{user}}の呼び名はミナト"),
                entry("r2", CoreMemorySection::Relationship, "{{user}}とは友達"),
                CoreMemoryEntry {
                    locked: true,
                    ..entry("s3", CoreMemorySection::SelfState, "髪を短く切った")
                },
            ],
        }
    }

    #[test]
    fn ops_add_replace_remove_and_demote() {
        let outcome = apply_ops(
            &sample(),
            vec![
                CoreMemoryOp::Add {
                    section: CoreMemorySection::Relationship,
                    text: "  週末に  水族館へ行く約束 ".to_owned(),
                },
                CoreMemoryOp::Replace {
                    id: "r2".to_owned(),
                    text: "{{user}}とは恋人同士".to_owned(),
                },
                CoreMemoryOp::Demote {
                    id: "u1".to_owned(),
                },
            ],
            10,
        );
        assert_eq!(outcome.applied, 3);
        assert!(outcome.rejected.is_empty());
        assert_eq!(outcome.demoted.len(), 1);
        assert_eq!(outcome.demoted[0].id, "u1");
        let memory = outcome.memory;
        assert_eq!(memory.version, 4);
        assert_eq!(memory.next_id, 5);
        let ids = memory
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry.text.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                ("r2", "{{user}}とは恋人同士"),
                ("r4", "週末に 水族館へ行く約束"),
                ("s3", "髪を短く切った"),
            ]
        );
    }

    #[test]
    fn locked_unknown_and_repeated_targets_are_rejected() {
        let outcome = apply_ops(
            &sample(),
            vec![
                CoreMemoryOp::Remove {
                    id: "s3".to_owned(),
                },
                CoreMemoryOp::Remove {
                    id: "x9".to_owned(),
                },
                CoreMemoryOp::Remove {
                    id: "r2".to_owned(),
                },
                CoreMemoryOp::Replace {
                    id: "r2".to_owned(),
                    text: "別の内容".to_owned(),
                },
            ],
            10,
        );
        assert_eq!(outcome.applied, 1);
        assert_eq!(outcome.rejected.len(), 3);
        assert_eq!(outcome.memory.entries.len(), 2);
    }

    #[test]
    fn nothing_applied_keeps_the_version() {
        let outcome = apply_ops(
            &sample(),
            vec![CoreMemoryOp::Add {
                section: CoreMemorySection::User,
                text: "{{user}}の呼び名はミナト".to_owned(),
            }],
            10,
        );
        assert_eq!(outcome.applied, 0);
        assert_eq!(outcome.memory, sample());
    }

    #[test]
    fn additions_over_the_limit_are_rejected_after_space_is_freed() {
        let mut memory = sample();
        memory.entries.push(entry(
            "u5",
            CoreMemorySection::User,
            &"あ".repeat(CORE_MEMORY_ENTRY_MAX_CHARS),
        ));
        for index in 6..10 {
            memory.entries.push(entry(
                &format!("u{index}"),
                CoreMemorySection::User,
                &format!("{index}{}", "い".repeat(CORE_MEMORY_ENTRY_MAX_CHARS - 1)),
            ));
        }
        memory.next_id = 10;
        assert!(memory.char_count() > CORE_MEMORY_MAX_CHARS - 20);
        let long = "う".repeat(150);
        let outcome = apply_ops(
            &memory,
            vec![
                CoreMemoryOp::Add {
                    section: CoreMemorySection::User,
                    text: long.clone(),
                },
                CoreMemoryOp::Add {
                    section: CoreMemorySection::User,
                    text: format!("{long}え"),
                },
                CoreMemoryOp::Demote {
                    id: "u5".to_owned(),
                },
            ],
            10,
        );
        // u5 を外して空いた分で1つ目は入るが、2つ目は入らない。
        assert_eq!(outcome.applied, 2);
        assert_eq!(outcome.rejected.len(), 1);
        assert!(outcome.rejected[0].reason.contains("上限"));
        assert!(outcome.memory.char_count() <= CORE_MEMORY_MAX_CHARS);
    }

    #[test]
    fn user_edits_get_ids_and_keep_unchanged_authors() {
        let previous = sample();
        let mut submitted = sample();
        submitted.version = 0;
        submitted.entries[1].text = "{{user}}とは親友".to_owned();
        submitted.entries.push(CoreMemoryEntry {
            id: String::new(),
            section: CoreMemorySection::User,
            text: "辛いものが苦手".to_owned(),
            locked: true,
            author: CoreMemoryAuthor::Ai,
            updated_at: 0,
        });
        submitted
            .entries
            .push(entry("u1", CoreMemorySection::User, "重複ID"));
        submitted
            .entries
            .push(entry("x", CoreMemorySection::User, "   "));
        let memory = normalize_user_edit(Some(&previous), submitted, 50).expect("valid edit");
        assert_eq!(memory.version, 4);
        let summary = memory
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry.author, entry.locked))
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                ("u1", CoreMemoryAuthor::Ai, false),
                ("u4", CoreMemoryAuthor::User, true),
                ("u5", CoreMemoryAuthor::User, false),
                ("r2", CoreMemoryAuthor::User, false),
                ("s3", CoreMemoryAuthor::Ai, true),
            ]
        );
        assert_eq!(memory.next_id, 6);
    }

    #[test]
    fn user_edits_over_the_limit_are_refused() {
        let mut submitted = CoreMemory::empty("c1");
        for _ in 0..6 {
            submitted.entries.push(entry(
                "",
                CoreMemorySection::User,
                &"あ".repeat(CORE_MEMORY_ENTRY_MAX_CHARS),
            ));
        }
        assert!(normalize_user_edit(None, submitted, 1).is_err());
    }

    #[test]
    fn character_rendering_groups_sections() {
        let rendered = sample().render_for_character("リン").expect("not empty");
        assert_eq!(
            rendered,
            "[About {{user}}]\n- {{user}}の呼び名はミナト\n\n[Relationship with {{user}}]\n- {{user}}とは友達\n\n[リン's current state]\n- 髪を短く切った"
        );
        assert!(
            CoreMemory::empty("c1")
                .render_for_character("リン")
                .is_none()
        );
        let update = sample().render_for_update();
        assert!(update.contains("s3 (locked): 髪を短く切った"));
        assert!(update.contains("[self]\n"));
    }
}
