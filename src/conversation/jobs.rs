use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Map, Value, json};
use tokio::{
    sync::Mutex,
    task::{AbortHandle, JoinHandle},
};

use crate::{
    AppState,
    db::{persist_conversation_result, persist_conversation_submission},
    error::{AppError, AppResult},
};

use super::orchestrator::run_turn;

const COMPLETED_JOB_RETENTION: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Default)]
pub struct ConversationJobs {
    inner: Arc<Mutex<HashMap<String, ConversationJob>>>,
}

#[derive(Clone)]
struct ConversationJob {
    id: String,
    room_id: String,
    status: JobStatus,
    result: Option<Value>,
    error: Option<String>,
    created_at: u64,
    updated_at: u64,
    recoverable: bool,
    abort_handle: Option<AbortHandle>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum JobStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

impl ConversationJob {
    fn snapshot(&self, include_result: bool) -> Value {
        let mut value = Map::from_iter([
            ("jobId".to_owned(), Value::String(self.id.clone())),
            ("roomId".to_owned(), Value::String(self.room_id.clone())),
            (
                "status".to_owned(),
                Value::String(self.status.as_str().to_owned()),
            ),
            ("createdAt".to_owned(), Value::from(self.created_at)),
            ("updatedAt".to_owned(), Value::from(self.updated_at)),
        ]);
        if include_result && let Some(result) = &self.result {
            value.insert("result".to_owned(), result.clone());
        }
        if let Some(error) = &self.error {
            value.insert("error".to_owned(), Value::String(error.clone()));
        }
        Value::Object(value)
    }
}

impl ConversationJobs {
    async fn insert(
        &self,
        job_id: String,
        room_id: String,
        recoverable: bool,
    ) -> AppResult<(Value, bool)> {
        let mut jobs = self.inner.lock().await;
        prune_jobs(&mut jobs);
        if let Some(existing) = jobs.get(&job_id) {
            return Ok((existing.snapshot(false), false));
        }
        if jobs
            .values()
            .any(|job| job.room_id == room_id && job.status == JobStatus::Running)
        {
            return Err(AppError::BadRequest(
                "このルームでは既に生成処理が実行中です。".to_owned(),
            ));
        }
        let now = now_millis();
        let job = ConversationJob {
            id: job_id.clone(),
            room_id,
            status: JobStatus::Running,
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
            recoverable,
            abort_handle: None,
        };
        let snapshot = job.snapshot(false);
        jobs.insert(job_id, job);
        Ok((snapshot, true))
    }

    async fn attach(&self, job_id: &str, handle: &JoinHandle<()>) {
        if let Some(job) = self.inner.lock().await.get_mut(job_id)
            && job.status == JobStatus::Running
        {
            job.abort_handle = Some(handle.abort_handle());
        }
    }

    async fn complete(&self, job_id: &str, result: Value) {
        if let Some(job) = self.inner.lock().await.get_mut(job_id)
            && job.status == JobStatus::Running
        {
            job.status = JobStatus::Completed;
            job.result = Some(result);
            job.updated_at = now_millis();
            job.abort_handle = None;
        }
    }

    async fn fail(&self, job_id: &str, error: String) {
        if let Some(job) = self.inner.lock().await.get_mut(job_id)
            && job.status == JobStatus::Running
        {
            job.status = JobStatus::Failed;
            job.error = Some(error);
            job.updated_at = now_millis();
            job.abort_handle = None;
        }
    }

    async fn get(&self, job_id: &str) -> Option<Value> {
        let mut jobs = self.inner.lock().await;
        prune_jobs(&mut jobs);
        jobs.get(job_id).map(|job| job.snapshot(true))
    }

    async fn list_recoverable(&self) -> Vec<Value> {
        let mut jobs = self.inner.lock().await;
        prune_jobs(&mut jobs);
        jobs.values()
            .filter(|job| job.recoverable)
            .map(|job| job.snapshot(false))
            .collect()
    }

    async fn cancel(&self, job_id: &str) -> Value {
        let mut jobs = self.inner.lock().await;
        let now = now_millis();
        let job = jobs
            .entry(job_id.to_owned())
            .or_insert_with(|| ConversationJob {
                id: job_id.to_owned(),
                room_id: String::new(),
                status: JobStatus::Cancelled,
                result: None,
                error: None,
                created_at: now,
                updated_at: now,
                recoverable: false,
                abort_handle: None,
            });
        if job.status == JobStatus::Running {
            job.status = JobStatus::Cancelled;
            job.updated_at = now;
            if let Some(handle) = job.abort_handle.take() {
                handle.abort();
            }
        }
        job.snapshot(false)
    }
}

pub async fn start(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let job_id = payload
        .get("jobId")
        .and_then(Value::as_str)
        .filter(|value| valid_job_id(value))
        .ok_or_else(|| AppError::BadRequest("jobId が不正です。".to_owned()))?
        .to_owned();
    let room_id = payload
        .pointer("/room/id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("room.id が必要です。".to_owned()))?
        .to_owned();
    let secret_mode = payload
        .get("secretMode")
        .and_then(Value::as_bool)
        .or_else(|| payload.pointer("/room/secretMode").and_then(Value::as_bool))
        .unwrap_or(false);

    let (snapshot, inserted) = state
        .conversation_jobs
        .insert(job_id.clone(), room_id.clone(), !secret_mode)
        .await?;
    if !inserted {
        return Ok((StatusCode::ACCEPTED, Json(snapshot)));
    }

    if let Err(error) =
        persist_conversation_submission(&state.database, &payload, secret_mode).await
    {
        state
            .conversation_jobs
            .fail(&job_id, error.to_string())
            .await;
        return Err(error);
    }

    let job_state = state.clone();
    let task_job_id = job_id.clone();
    let task_room_id = room_id;
    let handle = tokio::spawn(async move {
        match run_turn(job_state.clone(), payload).await {
            Ok(mut result) => {
                normalize_result_ids(&task_job_id, &mut result);
                if let Err(error) = persist_conversation_result(
                    &job_state.database,
                    &task_room_id,
                    &result,
                    secret_mode,
                )
                .await
                {
                    job_state
                        .conversation_jobs
                        .fail(&task_job_id, error.to_string())
                        .await;
                    return;
                }
                job_state
                    .conversation_jobs
                    .complete(&task_job_id, result)
                    .await;
            }
            Err(error) => {
                job_state
                    .conversation_jobs
                    .fail(&task_job_id, error.to_string())
                    .await;
            }
        }
    });
    state.conversation_jobs.attach(&job_id, &handle).await;

    Ok((StatusCode::ACCEPTED, Json(snapshot)))
}

pub async fn get(
    Path(job_id): Path<String>,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    state
        .conversation_jobs
        .get(&job_id)
        .await
        .map(Json)
        .ok_or_else(|| AppError::NotFound("生成ジョブが見つかりません。".to_owned()))
}

pub async fn list(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "jobs": state.conversation_jobs.list_recoverable().await,
    }))
}

pub async fn cancel(
    Path(job_id): Path<String>,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    if !valid_job_id(&job_id) {
        return Err(AppError::BadRequest("jobId が不正です。".to_owned()));
    }
    Ok(Json(state.conversation_jobs.cancel(&job_id).await))
}

fn valid_job_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn normalize_result_ids(job_id: &str, result: &mut Value) {
    let Some(messages) = result.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let timestamp = now_millis();
    let message_ids = messages
        .iter_mut()
        .enumerate()
        .filter_map(|(index, message)| {
            let object = message.as_object_mut()?;
            let id = format!("{job_id}-message-{index}");
            object.insert("id".to_owned(), Value::String(id.clone()));
            object.insert(
                "timestamp".to_owned(),
                Value::from(timestamp.saturating_add(index as u64)),
            );
            Some(id)
        })
        .collect::<Vec<_>>();

    if let Some(candidates) = result
        .get_mut("memoryCandidates")
        .and_then(Value::as_array_mut)
    {
        for candidate in candidates {
            if let Some(object) = candidate.as_object_mut() {
                object.insert("sourceMessageIds".to_owned(), json!(message_ids));
            }
        }
    }
    if let Some(usages) = result.get_mut("usages").and_then(Value::as_array_mut) {
        for (index, usage) in usages.iter_mut().enumerate() {
            if let Some(object) = usage.as_object_mut() {
                object.insert(
                    "id".to_owned(),
                    Value::String(format!("{job_id}-usage-{index}")),
                );
                object.insert(
                    "timestamp".to_owned(),
                    Value::from(timestamp.saturating_add(index as u64)),
                );
            }
        }
    }
}

fn prune_jobs(jobs: &mut HashMap<String, ConversationJob>) {
    let cutoff = now_millis().saturating_sub(COMPLETED_JOB_RETENTION.as_millis() as u64);
    jobs.retain(|_, job| !job.status.is_terminal() || job.updated_at >= cutoff);
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_ids_are_stable_and_unique_per_job() {
        let mut result = json!({
            "messages": [
                { "id": "old-1", "timestamp": 1 },
                { "id": "old-2", "timestamp": 2 }
            ],
            "usages": [{ "id": "old-usage", "timestamp": 1 }],
            "memoryCandidates": [{ "sourceMessageIds": ["old-1", "old-2"] }]
        });
        normalize_result_ids("job-12345678", &mut result);
        assert_eq!(result["messages"][0]["id"], "job-12345678-message-0");
        assert_eq!(result["messages"][1]["id"], "job-12345678-message-1");
        assert_eq!(result["usages"][0]["id"], "job-12345678-usage-0");
        assert_eq!(
            result["memoryCandidates"][0]["sourceMessageIds"],
            json!(["job-12345678-message-0", "job-12345678-message-1"])
        );
    }

    #[tokio::test]
    async fn cancellation_before_start_prevents_late_job_creation() {
        let jobs = ConversationJobs::default();
        let job_id = "job-cancel-before-start";
        let cancelled = jobs.cancel(job_id).await;
        assert_eq!(cancelled["status"], "cancelled");

        let (snapshot, inserted) = jobs
            .insert(job_id.to_owned(), "room-1".to_owned(), true)
            .await
            .expect("read cancellation tombstone");
        assert!(!inserted);
        assert_eq!(snapshot["status"], "cancelled");
    }
}
