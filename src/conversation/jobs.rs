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
    sync::{Mutex, OwnedMutexGuard},
    task::{AbortHandle, JoinHandle},
};
use tracing::Instrument;

use crate::{
    AppState,
    db::{
        persist_conversation_memories, persist_conversation_result, persist_conversation_submission,
    },
    error::{AppError, AppResult},
};

use super::{
    GenerationMode,
    memory::prepare_conversation_memories,
    orchestrator::{
        MemoryExtraction, MemoryFollowUp, ShadowGate, TurnOutput, extract_turn_memories, run_turn,
    },
};

const COMPLETED_JOB_RETENTION: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Default)]
pub struct ConversationJobs {
    inner: Arc<Mutex<HashMap<String, ConversationJob>>>,
    history_persistence: Arc<Mutex<()>>,
    memory_persistence: Arc<Mutex<()>>,
}

#[derive(Clone)]
struct ConversationJob {
    id: String,
    room_id: String,
    status: JobStatus,
    result: Option<Value>,
    partial_result: Option<Value>,
    error: Option<String>,
    preview: Option<Value>,
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
        if include_result && let Some(partial_result) = &self.partial_result {
            value.insert("partialResult".to_owned(), partial_result.clone());
        }
        if let Some(preview) = &self.preview {
            value.insert("preview".to_owned(), preview.clone());
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
            return Ok((existing.snapshot(existing.status.is_terminal()), false));
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
            partial_result: None,
            error: None,
            preview: None,
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

    async fn is_running(&self, job_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .get(job_id)
            .is_some_and(|job| job.status == JobStatus::Running)
    }

    pub(crate) async fn lock_history_persistence(&self) -> OwnedMutexGuard<()> {
        self.history_persistence.clone().lock_owned().await
    }

    async fn lock_memory_persistence(&self) -> OwnedMutexGuard<()> {
        self.memory_persistence.clone().lock_owned().await
    }

    async fn complete(&self, job_id: &str, result: Value) {
        if let Some(job) = self.inner.lock().await.get_mut(job_id)
            && job.status == JobStatus::Running
        {
            job.status = JobStatus::Completed;
            job.result = Some(result);
            job.partial_result = None;
            job.updated_at = now_millis();
            job.abort_handle = None;
        }
    }

    async fn fail(&self, job_id: &str, error: String, full_json_logs: Vec<Value>) {
        if let Some(job) = self.inner.lock().await.get_mut(job_id)
            && job.status == JobStatus::Running
        {
            job.status = JobStatus::Failed;
            job.partial_result = (!full_json_logs.is_empty()).then(|| {
                json!({
                    "fullJsonLogs": full_json_logs,
                })
            });
            job.error = Some(error);
            job.updated_at = now_millis();
            job.abort_handle = None;
        }
    }

    pub(crate) fn update_preview(
        &self,
        job_id: &str,
        content: &str,
        character_id: &str,
        character_name: &str,
        expression: Option<&str>,
    ) {
        if content.trim().is_empty() && expression.is_none() {
            return;
        }
        let Ok(mut jobs) = self.inner.try_lock() else {
            return;
        };
        let Some(job) = jobs.get_mut(job_id) else {
            return;
        };
        if job.status != JobStatus::Running {
            return;
        }
        let mut turns = job
            .preview
            .as_ref()
            .and_then(|preview| preview.get("turns"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let continue_last_turn = turns.last().is_some_and(|turn| {
            !turn
                .get("complete")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && turn.get("characterId").and_then(Value::as_str) == Some(character_id)
        });
        let turn_index = if continue_last_turn {
            turns.len().saturating_sub(1)
        } else {
            let index = turns.len();
            turns.push(json!({
                "turnIndex": index,
                "content": content,
                "characterId": character_id,
                "characterName": character_name,
                "complete": false,
            }));
            index
        };
        if continue_last_turn {
            turns[turn_index]["content"] = Value::String(content.to_owned());
            turns[turn_index]["characterName"] = Value::String(character_name.to_owned());
        }
        if let Some(expression) = expression {
            turns[turn_index]["expression"] = Value::String(expression.to_owned());
        }
        let expression = turns[turn_index].get("expression").cloned();
        let mut preview = json!({
            "content": content,
            "characterId": character_id,
            "characterName": character_name,
            "turns": turns,
        });
        if let Some(expression) = expression {
            preview["expression"] = expression;
        }
        job.preview = Some(preview);
        job.updated_at = now_millis();
    }

    pub(crate) async fn finalize_preview(
        &self,
        job_id: &str,
        content: &str,
        character_id: &str,
        character_name: &str,
        formatted_messages: &[String],
        expression: Option<&str>,
    ) {
        if content.trim().is_empty() {
            return;
        }
        let mut jobs = self.inner.lock().await;
        let Some(job) = jobs.get_mut(job_id) else {
            return;
        };
        if job.status != JobStatus::Running {
            return;
        }
        let mut turns = job
            .preview
            .as_ref()
            .and_then(|preview| preview.get("turns"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let continue_last_turn = turns.last().is_some_and(|turn| {
            !turn
                .get("complete")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && turn.get("characterId").and_then(Value::as_str) == Some(character_id)
        });
        let turn_index = if continue_last_turn {
            turns.len().saturating_sub(1)
        } else {
            let index = turns.len();
            turns.push(json!({}));
            index
        };
        let mut turn = json!({
            "turnIndex": turn_index,
            "content": content,
            "characterId": character_id,
            "characterName": character_name,
            "formattedMessages": formatted_messages,
            "complete": true,
        });
        if let Some(expression) = expression {
            turn["expression"] = Value::String(expression.to_owned());
        }
        turns[turn_index] = turn;
        let mut preview = json!({
            "content": content,
            "characterId": character_id,
            "characterName": character_name,
            "formattedMessages": formatted_messages,
            "turns": turns,
        });
        if let Some(expression) = expression {
            preview["expression"] = Value::String(expression.to_owned());
        }
        job.preview = Some(preview);
        job.updated_at = now_millis();
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
            .map(|job| job.snapshot(job.status.is_terminal()))
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
                partial_result: None,
                error: None,
                preview: None,
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

    pub(crate) async fn cancel_recoverable(&self) {
        let mut jobs = self.inner.lock().await;
        let now = now_millis();
        for job in jobs.values_mut() {
            if !job.recoverable || job.status != JobStatus::Running {
                continue;
            }
            job.status = JobStatus::Cancelled;
            job.updated_at = now;
            if let Some(handle) = job.abort_handle.take() {
                handle.abort();
            }
        }
    }
}

pub async fn start(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let generation_mode = GenerationMode::from_payload(&payload)?;
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
    tracing::debug!(
        job_id,
        secret_mode,
        stage = "accepted",
        "Conversation job accepted"
    );

    let (snapshot, inserted) = state
        .conversation_jobs
        .insert(job_id.clone(), room_id.clone(), !secret_mode)
        .await?;
    if !inserted {
        tracing::debug!(
            job_id,
            stage = "already_exists",
            "Conversation job already exists"
        );
        return Ok((StatusCode::ACCEPTED, Json(snapshot)));
    }

    let history_persistence_guard = if secret_mode {
        None
    } else {
        Some(state.conversation_jobs.lock_history_persistence().await)
    };
    if !state.conversation_jobs.is_running(&job_id).await {
        tracing::debug!(
            job_id,
            stage = "cancelled_before_persistence",
            "Conversation job was cancelled before persistence"
        );
        let current = state
            .conversation_jobs
            .get(&job_id)
            .await
            .unwrap_or(snapshot);
        return Ok((StatusCode::ACCEPTED, Json(current)));
    }
    tracing::debug!(
        job_id,
        stage = "persisting_submission",
        "Conversation job is persisting the submitted turn"
    );
    if let Err(error) = persist_conversation_submission(
        &state.database,
        &payload,
        secret_mode,
        generation_mode.is_continue(),
    )
    .await
    {
        tracing::warn!(
            job_id,
            stage = "submission_persistence_failed",
            classification = error.diagnostic_class(),
            "Conversation job could not persist the submitted turn"
        );
        state
            .conversation_jobs
            .fail(&job_id, error.to_string(), Vec::new())
            .await;
        return Err(error);
    }
    tracing::debug!(
        job_id,
        stage = "submission_persisted",
        "Conversation job persisted the submitted turn"
    );
    drop(history_persistence_guard);

    let job_state = state.clone();
    let task_job_id = job_id.clone();
    let task_room_id = room_id;
    let job_span = tracing::debug_span!("conversation_job", job_id = %task_job_id);
    let handle = tokio::spawn(
        async move {
            tracing::debug!(
                stage = "generation_started",
                "Conversation generation started"
            );
            match run_turn(job_state.clone(), payload.clone()).await {
                Ok(TurnOutput { mut result, memory }) => {
                    let message_count = result
                        .get("messages")
                        .and_then(serde_json::Value::as_array)
                        .map_or(0, Vec::len);
                    tracing::debug!(
                        stage = "generation_completed",
                        message_count,
                        "Conversation generation completed"
                    );
                    normalize_result_ids(&task_job_id, &mut result);
                    let history_persistence_guard = if secret_mode {
                        None
                    } else {
                        Some(job_state.conversation_jobs.lock_history_persistence().await)
                    };
                    if !job_state.conversation_jobs.is_running(&task_job_id).await {
                        tracing::debug!(
                            stage = "cancelled_before_result_persistence",
                            "Conversation job was cancelled before result persistence"
                        );
                        return;
                    }
                    tracing::debug!(
                        stage = "persisting_result",
                        "Conversation job is persisting the generated result"
                    );
                    if let Err(error) = persist_conversation_result(
                        &job_state.database,
                        &task_room_id,
                        &result,
                        secret_mode,
                    )
                    .await
                    {
                        tracing::warn!(
                            stage = "result_persistence_failed",
                            classification = error.diagnostic_class(),
                            "Conversation job could not persist the generated result"
                        );
                        job_state
                            .conversation_jobs
                            .fail(
                                &task_job_id,
                                error.to_string(),
                                result
                                    .get("fullJsonLogs")
                                    .and_then(Value::as_array)
                                    .cloned()
                                    .unwrap_or_default(),
                            )
                            .await;
                        return;
                    }
                    tracing::debug!(
                        stage = "result_persisted",
                        "Conversation job persisted the generated result"
                    );
                    drop(history_persistence_guard);
                    let memory = memory.filter(|_| !secret_mode).map(|follow_up| {
                        let messages = result
                            .get("messages")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        (follow_up, messages)
                    });
                    job_state
                        .conversation_jobs
                        .complete(&task_job_id, result)
                        .await;
                    tracing::debug!(stage = "completed", "Conversation job completed");
                    if let Some((follow_up, messages)) = memory {
                        persist_turn_memories(
                            &job_state,
                            &payload,
                            &task_job_id,
                            follow_up,
                            &messages,
                        )
                        .await;
                    }
                }
                Err(failure) => {
                    tracing::warn!(
                        stage = "generation_failed",
                        classification = failure.error.diagnostic_class(),
                        "Conversation generation failed"
                    );
                    job_state
                        .conversation_jobs
                        .fail(
                            &task_job_id,
                            failure.error.to_string(),
                            failure.full_json_logs,
                        )
                        .await;
                }
            }
        }
        .instrument(job_span),
    );
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
    tracing::debug!(
        job_id,
        stage = "cancellation_requested",
        "Conversation job cancellation requested"
    );
    Ok(Json(state.conversation_jobs.cancel(&job_id).await))
}

fn valid_job_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

async fn persist_turn_memories(
    state: &AppState,
    payload: &Value,
    job_id: &str,
    follow_up: MemoryFollowUp,
    messages: &[Value],
) {
    tracing::debug!(
        stage = "memory_extraction_started",
        "Conversation memory extraction started"
    );
    let MemoryExtraction {
        mut candidates,
        mut usages,
        shadow,
    } = match extract_turn_memories(state, payload, follow_up, messages).await {
        Ok(extraction) => extraction,
        Err(error) => {
            tracing::warn!(
                stage = "memory_extraction_failed",
                classification = error.diagnostic_class(),
                "Conversation memory extraction failed"
            );
            return;
        }
    };
    let source_message_ids = content_message_ids(messages);
    normalize_memory_follow_up_ids(job_id, &mut candidates, &mut usages, &source_message_ids);
    let candidate_count = candidates.len();
    let _memory_persistence_guard = state.conversation_jobs.lock_memory_persistence().await;
    let prepared = match prepare_conversation_memories(state, payload, messages, candidates).await {
        Ok(prepared) => prepared,
        Err(error) => {
            tracing::warn!(
                stage = "memory_preparation_failed",
                classification = error.diagnostic_class(),
                "Conversation memories could not be prepared"
            );
            Vec::new()
        }
    };
    let saved_count = prepared.len();
    if let Some(gate) = shadow {
        tracing::info!(
            stage = "memory_gate_shadow",
            gate = gate.as_str(),
            candidate_count,
            saved_count,
            agreement = memory_gate_shadow_agreement(gate, saved_count > 0),
            "Memory gate shadow comparison"
        );
    }
    let _history_persistence_guard = state.conversation_jobs.lock_history_persistence().await;
    match persist_conversation_memories(&state.database, source_message_ids, prepared, usages).await
    {
        Ok(true) => tracing::debug!(
            stage = "memories_persisted",
            saved_count,
            "Conversation memories persisted"
        ),
        Ok(false) => tracing::debug!(
            stage = "memories_discarded",
            "Conversation memories were discarded because their source messages no longer exist"
        ),
        Err(error) => tracing::warn!(
            stage = "memory_persistence_failed",
            classification = error.diagnostic_class(),
            "Conversation memories could not be persisted"
        ),
    }
}

fn memory_gate_shadow_agreement(gate: ShadowGate, saved: bool) -> &'static str {
    match (gate, saved) {
        (ShadowGate::Failed, _) => "gate_failed",
        (ShadowGate::Extract, true) | (ShadowGate::Skip, false) => "agree",
        (ShadowGate::Skip, true) => "missed",
        (ShadowGate::Extract, false) => "unneeded",
    }
}

fn normalize_result_ids(job_id: &str, result: &mut Value) {
    let Some(messages) = result.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let timestamp = now_millis();
    for (index, message) in messages.iter_mut().enumerate() {
        if let Some(object) = message.as_object_mut() {
            object.insert(
                "id".to_owned(),
                Value::String(format!("{job_id}-message-{index}")),
            );
            object.insert(
                "timestamp".to_owned(),
                Value::from(timestamp.saturating_add(index as u64)),
            );
        }
    }
    if let Some(usages) = result.get_mut("usages").and_then(Value::as_array_mut) {
        normalize_usage_ids(usages, &format!("{job_id}-usage"), timestamp);
    }
}

fn normalize_memory_follow_up_ids(
    job_id: &str,
    candidates: &mut [Value],
    usages: &mut [Value],
    source_message_ids: &[String],
) {
    for (index, candidate) in candidates.iter_mut().enumerate() {
        if let Some(object) = candidate.as_object_mut() {
            object.insert(
                "id".to_owned(),
                Value::String(format!("{job_id}-memory-{index}")),
            );
            object.insert("sourceMessageIds".to_owned(), json!(source_message_ids));
        }
    }
    normalize_usage_ids(usages, &format!("{job_id}-memory-usage"), now_millis());
}

fn normalize_usage_ids(usages: &mut [Value], prefix: &str, timestamp: u64) {
    for (index, usage) in usages.iter_mut().enumerate() {
        if let Some(object) = usage.as_object_mut() {
            object.insert("id".to_owned(), Value::String(format!("{prefix}-{index}")));
            object.insert(
                "timestamp".to_owned(),
                Value::from(timestamp.saturating_add(index as u64)),
            );
        }
    }
}

fn content_message_ids(messages: &[Value]) -> Vec<String> {
    messages
        .iter()
        .filter(|message| {
            message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| !content.trim().is_empty())
        })
        .filter_map(|message| message.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
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
                { "id": "old-1", "content": "first", "timestamp": 1 },
                { "id": "old-2", "content": "second", "timestamp": 2 },
                { "id": "old-3", "content": " ", "timestamp": 3 }
            ],
            "usages": [{ "id": "old-usage", "timestamp": 1 }]
        });
        normalize_result_ids("job-12345678", &mut result);
        assert_eq!(result["messages"][0]["id"], "job-12345678-message-0");
        assert_eq!(result["messages"][1]["id"], "job-12345678-message-1");
        assert_eq!(result["usages"][0]["id"], "job-12345678-usage-0");

        let messages = result["messages"].as_array().expect("messages");
        let source_message_ids = content_message_ids(messages);
        assert_eq!(
            source_message_ids,
            vec!["job-12345678-message-0", "job-12345678-message-1"]
        );
        let mut candidates = vec![json!({ "sourceMessageIds": ["old-1"] })];
        let mut usages = vec![json!({ "id": "usage-memory" })];
        normalize_memory_follow_up_ids(
            "job-12345678",
            &mut candidates,
            &mut usages,
            &source_message_ids,
        );
        assert_eq!(candidates[0]["id"], "job-12345678-memory-0");
        assert_eq!(
            candidates[0]["sourceMessageIds"],
            json!(["job-12345678-message-0", "job-12345678-message-1"])
        );
        assert_eq!(usages[0]["id"], "job-12345678-memory-usage-0");
    }

    #[test]
    fn memory_gate_shadow_agreement_classifies_gate_outcomes() {
        assert_eq!(
            memory_gate_shadow_agreement(ShadowGate::Extract, true),
            "agree"
        );
        assert_eq!(
            memory_gate_shadow_agreement(ShadowGate::Skip, false),
            "agree"
        );
        assert_eq!(
            memory_gate_shadow_agreement(ShadowGate::Skip, true),
            "missed"
        );
        assert_eq!(
            memory_gate_shadow_agreement(ShadowGate::Extract, false),
            "unneeded"
        );
        assert_eq!(
            memory_gate_shadow_agreement(ShadowGate::Failed, true),
            "gate_failed"
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

    #[tokio::test]
    async fn cancelling_recoverable_jobs_keeps_secret_jobs_running() {
        let jobs = ConversationJobs::default();
        let (recoverable, _) = jobs
            .insert(
                "job-recoverable".to_owned(),
                "room-recoverable".to_owned(),
                true,
            )
            .await
            .expect("insert recoverable job");
        let (secret, _) = jobs
            .insert("job-secret".to_owned(), "room-secret".to_owned(), false)
            .await
            .expect("insert secret job");
        assert_eq!(recoverable["status"], "running");
        assert_eq!(secret["status"], "running");

        jobs.cancel_recoverable().await;

        let recoverable = jobs.get("job-recoverable").await.expect("recoverable job");
        let secret = jobs.get("job-secret").await.expect("secret job");
        assert_eq!(recoverable["status"], "cancelled");
        assert_eq!(secret["status"], "running");
        let listed = jobs.list_recoverable().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["jobId"], "job-recoverable");
    }

    #[tokio::test]
    async fn failed_jobs_expose_all_collected_debug_logs() {
        let jobs = ConversationJobs::default();
        let job_id = "job-failed-with-debug-logs";
        jobs.insert(job_id.to_owned(), "room-1".to_owned(), true)
            .await
            .expect("insert job");
        let logs = vec![
            json!({
                "status": "success",
                "source": "director-json",
                "json": "{\"actorId\":\"actor-1\"}",
            }),
            json!({
                "status": "error",
                "source": "chat-http-error",
                "json": "{\"error\":\"upstream failed\"}",
            }),
        ];

        jobs.fail(job_id, "generation failed".to_owned(), logs.clone())
            .await;

        let snapshot = jobs.get(job_id).await.expect("failed job");
        assert_eq!(snapshot["status"], "failed");
        assert_eq!(snapshot["partialResult"]["fullJsonLogs"], json!(logs));

        let (duplicate, inserted) = jobs
            .insert(job_id.to_owned(), "room-1".to_owned(), true)
            .await
            .expect("read existing failed job");
        assert!(!inserted);
        assert_eq!(
            duplicate["partialResult"]["fullJsonLogs"],
            snapshot["partialResult"]["fullJsonLogs"]
        );

        let listed = jobs.list_recoverable().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0]["partialResult"]["fullJsonLogs"],
            snapshot["partialResult"]["fullJsonLogs"]
        );
    }

    #[tokio::test]
    async fn completed_jobs_expose_results_when_listed_for_recovery() {
        let jobs = ConversationJobs::default();
        let job_id = "job-completed-with-debug-logs";
        jobs.insert(job_id.to_owned(), "room-1".to_owned(), true)
            .await
            .expect("insert job");
        jobs.complete(
            job_id,
            json!({
                "messages": [{ "id": "message-1", "content": "reply" }],
                "fullJsonLogs": [{
                    "status": "success",
                    "source": "chat-json",
                    "json": "{\"reply\":\"reply\"}",
                }],
            }),
        )
        .await;

        let listed = jobs.list_recoverable().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["status"], "completed");
        assert_eq!(listed[0]["result"]["messages"][0]["id"], "message-1");
        assert_eq!(
            listed[0]["result"]["fullJsonLogs"][0]["source"],
            "chat-json"
        );
    }

    #[tokio::test]
    async fn streaming_preview_keeps_completed_actor_turns_in_order() {
        let jobs = ConversationJobs::default();
        let job_id = "job-streaming-turns";
        jobs.insert(job_id.to_owned(), "room-1".to_owned(), true)
            .await
            .expect("insert streaming job");

        jobs.update_preview(job_id, "", "actor-a", "A", Some("happy"));
        let snapshot = jobs.get(job_id).await.expect("expression-only preview");
        assert_eq!(snapshot["preview"]["expression"], "happy");
        assert_eq!(snapshot["preview"]["turns"][0]["expression"], "happy");
        assert_eq!(snapshot["preview"]["turns"][0]["complete"], false);
        jobs.update_preview(job_id, "こ", "actor-a", "A", Some("happy"));
        jobs.update_preview(job_id, "こんにちは", "actor-a", "A", None);
        assert_eq!(
            jobs.get(job_id).await.unwrap()["preview"]["expression"],
            "happy"
        );
        jobs.finalize_preview(job_id, "こんにちは", "actor-a", "A", &[], Some("happy"))
            .await;
        jobs.update_preview(job_id, "や", "actor-b", "B", None);
        jobs.finalize_preview(job_id, "やあ", "actor-b", "B", &[], None)
            .await;

        let snapshot = jobs.get(job_id).await.expect("streaming job");
        let turns = snapshot["preview"]["turns"]
            .as_array()
            .expect("preview turns");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["turnIndex"], 0);
        assert_eq!(turns[0]["content"], "こんにちは");
        assert_eq!(turns[0]["characterId"], "actor-a");
        assert_eq!(turns[0]["expression"], "happy");
        assert_eq!(turns[0]["complete"], true);
        assert_eq!(turns[1]["turnIndex"], 1);
        assert_eq!(turns[1]["content"], "やあ");
        assert_eq!(turns[1]["characterId"], "actor-b");
        assert_eq!(turns[1]["complete"], true);
    }
}
