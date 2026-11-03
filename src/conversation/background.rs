//! 返信のあとに裏で走るタスク（記憶の抽出など）の記録。
//!
//! 生成ジョブの結果を返したあとに動く処理は画面から見えないため、
//! 実行中・完了・失敗とデバッグログをここに残し、デバッグログ画面から読めるようにする。

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

/// 残しておく終了済みタスクの上限。実行中のタスクは数えずに残す。
const FINISHED_TASK_LIMIT: usize = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackgroundTaskKind {
    /// たまった発言からの記憶のバッチ抽出。
    MemoryBatch,
}

impl BackgroundTaskKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::MemoryBatch => "memory-batch",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackgroundTaskStatus {
    Running,
    Completed,
    Failed,
}

impl BackgroundTaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// タスクを始めるときに渡す情報。
pub(crate) struct BackgroundTaskStart<'a> {
    pub(crate) kind: BackgroundTaskKind,
    /// なぜ走ったか（「ターン後」「ルーム離脱」など）。
    pub(crate) reason: &'a str,
    pub(crate) room_id: &'a str,
    pub(crate) character: Option<&'a Value>,
}

struct BackgroundTask {
    id: String,
    kind: BackgroundTaskKind,
    reason: String,
    room_id: String,
    character_id: String,
    character_name: String,
    status: BackgroundTaskStatus,
    detail: Option<String>,
    error: Option<String>,
    started_at: u64,
    finished_at: Option<u64>,
    full_json_logs: Vec<Value>,
}

impl BackgroundTask {
    fn snapshot(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind.as_str(),
            "reason": self.reason,
            "roomId": self.room_id,
            "characterId": self.character_id,
            "characterName": self.character_name,
            "status": self.status.as_str(),
            "detail": self.detail,
            "error": self.error,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "fullJsonLogs": self.full_json_logs,
        })
    }
}

#[derive(Default)]
struct TaskLog {
    next_id: u64,
    tasks: VecDeque<BackgroundTask>,
}

impl TaskLog {
    fn task_mut(&mut self, id: &str) -> Option<&mut BackgroundTask> {
        self.tasks.iter_mut().find(|task| task.id == id)
    }

    /// 古い終了済みタスクから捨てる。
    fn prune(&mut self) {
        let mut finished = self
            .tasks
            .iter()
            .filter(|task| task.status != BackgroundTaskStatus::Running)
            .count();
        while finished > FINISHED_TASK_LIMIT {
            let Some(index) = self
                .tasks
                .iter()
                .position(|task| task.status != BackgroundTaskStatus::Running)
            else {
                break;
            };
            self.tasks.remove(index);
            finished -= 1;
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct BackgroundTasks {
    inner: Arc<Mutex<TaskLog>>,
}

impl BackgroundTasks {
    pub(crate) fn start(&self, start: BackgroundTaskStart<'_>) -> BackgroundTaskHandle {
        let character = start.character;
        let field = |key: &str| {
            character
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let started_at = now_millis();
        let mut log = self.lock();
        log.next_id += 1;
        let id = format!("bg-{started_at}-{}", log.next_id);
        log.tasks.push_back(BackgroundTask {
            id: id.clone(),
            kind: start.kind,
            reason: start.reason.to_owned(),
            room_id: start.room_id.to_owned(),
            character_id: field("id"),
            character_name: field("name"),
            status: BackgroundTaskStatus::Running,
            detail: None,
            error: None,
            started_at,
            finished_at: None,
            full_json_logs: Vec::new(),
        });
        drop(log);
        BackgroundTaskHandle {
            tasks: self.clone(),
            id,
            finished: false,
        }
    }

    /// 新しい順のタスク一覧。
    pub(crate) fn list(&self) -> Vec<Value> {
        self.lock()
            .tasks
            .iter()
            .rev()
            .map(BackgroundTask::snapshot)
            .collect()
    }

    fn update(&self, id: &str, apply: impl FnOnce(&mut BackgroundTask)) {
        let mut log = self.lock();
        if let Some(task) = log.task_mut(id) {
            apply(task);
        }
    }

    fn finish(
        &self,
        id: &str,
        status: BackgroundTaskStatus,
        apply: impl FnOnce(&mut BackgroundTask),
    ) {
        let mut log = self.lock();
        if let Some(task) = log.task_mut(id) {
            apply(task);
            task.status = status;
            task.finished_at = Some(now_millis());
        }
        log.prune();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, TaskLog> {
        // 記録が壊れても会話の処理は止めたくないので、毒されたロックもそのまま使う。
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 実行中のタスク。完了・失敗を伝えずに drop されたら失敗として残す。
pub(crate) struct BackgroundTaskHandle {
    tasks: BackgroundTasks,
    id: String,
    finished: bool,
}

impl BackgroundTaskHandle {
    /// 実行中の進み具合を書き換える。
    pub(crate) fn set_detail(&self, detail: impl Into<String>) {
        let detail = detail.into();
        self.tasks
            .update(&self.id, |task| task.detail = Some(detail));
    }

    pub(crate) fn push_logs(&self, logs: Vec<Value>) {
        if logs.is_empty() {
            return;
        }
        self.tasks
            .update(&self.id, |task| task.full_json_logs.extend(logs));
    }

    pub(crate) fn complete(mut self, detail: impl Into<String>) {
        let detail = detail.into();
        self.finished = true;
        self.tasks
            .finish(&self.id, BackgroundTaskStatus::Completed, |task| {
                task.detail = Some(detail);
            });
    }

    pub(crate) fn fail(mut self, error: impl Into<String>) {
        let error = error.into();
        self.finished = true;
        self.tasks
            .finish(&self.id, BackgroundTaskStatus::Failed, |task| {
                task.error = Some(error);
            });
    }
}

impl Drop for BackgroundTaskHandle {
    fn drop(&mut self) {
        if !self.finished {
            self.tasks
                .finish(&self.id, BackgroundTaskStatus::Failed, |task| {
                    task.error = Some("処理が途中で終了しました。".to_owned());
                });
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn start(tasks: &BackgroundTasks, character: &Value) -> BackgroundTaskHandle {
        tasks.start(BackgroundTaskStart {
            kind: BackgroundTaskKind::MemoryBatch,
            reason: "ターン後",
            room_id: "room-1",
            character: Some(character),
        })
    }

    #[test]
    fn tasks_report_progress_and_completion_newest_first() {
        let tasks = BackgroundTasks::default();
        let character = json!({"id": "char-1", "name": "アリス"});
        let first = start(&tasks, &character);
        first.set_detail("抽出中");
        first.push_logs(vec![json!({"source": "memory-batch-json"})]);
        let second = start(&tasks, &character);

        let listed = tasks.list();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[1]["status"], "running");
        assert_eq!(listed[1]["detail"], "抽出中");
        assert_eq!(listed[1]["characterName"], "アリス");
        assert_eq!(listed[1]["kind"], "memory-batch");
        assert_eq!(listed[1]["fullJsonLogs"].as_array().map(Vec::len), Some(1));

        first.complete("保存 2 件");
        second.fail("失敗");
        let listed = tasks.list();
        assert_eq!(listed[1]["status"], "completed");
        assert_eq!(listed[1]["detail"], "保存 2 件");
        assert!(listed[1]["finishedAt"].is_u64());
        assert_eq!(listed[0]["status"], "failed");
        assert_eq!(listed[0]["error"], "失敗");
    }

    #[test]
    fn dropped_tasks_are_recorded_as_failed() {
        let tasks = BackgroundTasks::default();
        let character = json!({"id": "char-1"});
        drop(start(&tasks, &character));
        let listed = tasks.list();
        assert_eq!(listed[0]["status"], "failed");
        assert!(listed[0]["error"].is_string());
    }

    #[test]
    fn only_recent_finished_tasks_are_kept_while_running_tasks_stay() {
        let tasks = BackgroundTasks::default();
        let character = json!({"id": "char-1"});
        let running = start(&tasks, &character);
        for _ in 0..FINISHED_TASK_LIMIT + 5 {
            start(&tasks, &character).complete("ok");
        }
        let listed = tasks.list();
        assert_eq!(listed.len(), FINISHED_TASK_LIMIT + 1);
        assert!(listed.iter().any(|task| task["status"] == "running"));
        running.complete("ok");
    }
}
