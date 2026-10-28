use std::{
    collections::{HashMap, HashSet},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{Json, extract::State};
use serde_json::{Map, Value, json};

use crate::{
    AppState,
    ai::{
        AiApiClient, AiApiConfig, ai_api_config_value,
        routes::{
            RoleSelection, extract_message_reasoning, extract_message_text,
            memory_extraction_guided_prompt, memory_extraction_prompt, memory_schema, model_string,
            optional_role_selection, parse_memory_updates, plain_text_completion,
            plain_text_completion_streaming, resolve_role_selection, structured_completion,
            structured_completion_streaming,
        },
        typesafe::{SystemOneResponse, system_one},
    },
    error::{AppError, AppResult},
};

use super::{
    GenerationMode,
    jobs::{ConversationJobs, JobCancellation},
    memory::request_embedding,
    memory_date,
    memory_gate::{
        MEMORY_GATE_TIMEOUT_SECS, MemoryGateDecision, MemoryGateReason, MemoryGateTurn,
        evaluate_memory_gate, memory_gate_questions, memory_gate_state,
    },
    prompts::{
        EnsembleCast, InjectedMemory, NARRATOR_ID, ReplyFormat, SUMMARY_RECENT_USER_TURNS_TO_KEEP,
        actor_id, assistant_schema, boolean, character_setting, character_system_prompt,
        ensemble_max_items, ensemble_schema, ensemble_system_prompt, message_image_attachment_urls, message_text_with_attachments,
        string, summary_prompts, summary_schema,
    },
    response::{
        AssistantEnvelope, EnsembleSpeaker, EnsembleTurnPreview, assistant_expression_preview,
        assistant_motion_preview, assistant_response_preview, ensemble_response_preview,
        limit_assistant_reply_characters, parse_assistant_response, parse_ensemble_response,
        parse_summary_response, plain_assistant_response, plain_response_preview,
        sanitize_assistant_reply_content, sanitize_message_content,
    },
};

const DEFAULT_MAX_HISTORY: usize = 20;
const CHAT_COMPLETION_MAX_TOKENS: u64 = 2048;
const DEFAULT_MAX_CHARACTERS: u64 = 512;
const DEFAULT_TEMPERATURE: f64 = 0.8;
const DEFAULT_TOP_P: f64 = 1.0;
const DEFAULT_TOP_K: u64 = 0;
const MEMORY_LIMIT: usize = 8;
const MEMORY_MIN_IMPORTANCE: f64 = 0.4;
const MEMORY_MIN_CONFIDENCE: f64 = 0.7;
const MEMORY_MAX_CANDIDATES: usize = 5;
/// 無関係なメモリをコンテキストへ注入しないための関連度の下限。
/// 重要度・確信度・新しさ・固定は並び順にだけ効かせ、注入の可否は関連度だけで決める。
const MEMORY_MIN_VECTOR_SIMILARITY: f64 = 0.35;
const MEMORY_MIN_LEXICAL_SIMILARITY: f64 = 0.25;
const CONTINATUION_TRIGGER: &str = "[内部指示] これは{{user}}の発言ではありません。{{user}}から新しい発言や行動はありません。直前の場面を繰り返さず、自然な続きを作成してください。もし前回のレスポンスが途中で途切れている場合、その続きから作成してください。";

/// Lazily builds and caches one `AiApiClient` per connection id so a single
/// turn can mix roles/characters pinned to different connections.
struct RequestClients<'a> {
    state: &'a AppState,
    api_config: Option<AiApiConfig>,
    clients: HashMap<String, AiApiClient>,
}

impl<'a> RequestClients<'a> {
    fn new(state: &'a AppState, api_config: Option<AiApiConfig>) -> Self {
        Self {
            state,
            api_config,
            clients: HashMap::new(),
        }
    }

    fn for_connection(&mut self, connection_id: Option<&str>) -> AppResult<AiApiClient> {
        let client = AiApiClient::resolve_for(
            self.state.http_client.clone(),
            self.state.application_origin.clone(),
            &self.state.ai_config.effective(),
            self.api_config.clone(),
            connection_id,
        )?;
        Ok(self
            .clients
            .entry(client.connection_id().to_owned())
            .or_insert(client)
            .clone())
    }

    fn for_selection(&mut self, selection: &RoleSelection) -> AppResult<AiApiClient> {
        self.for_connection(selection.connection_id.as_deref())
    }

    fn user_name(&self) -> &str {
        crate::user_placeholder::normalized_user_name(
            self.api_config
                .as_ref()
                .and_then(|config| config.user_name.as_deref()),
        )
    }
}

fn character_max_characters(character: &Value) -> usize {
    usize::try_from(number_u64(character, "maxCharacters", DEFAULT_MAX_CHARACTERS).max(1))
        .unwrap_or(usize::MAX)
}

/// OpenRouterの `reasoning.effort` として受理する値だけを通す。
fn reasoning_effort_str(value: Option<&str>) -> Option<&str> {
    value.filter(|effort| matches!(*effort, "none" | "low" | "medium" | "high"))
}

/// 連鎖上限をOFFにしたときも、出力が長くなりすぎないように内部で使う発言数の上限。
const SITUATION_TURN_CAP: usize = 10;

/// シチュエーションの1ターンでキャラクターが話せる発言数の上限。`None` は上限なし。
/// 上限は `limitTurns` がONのときだけ使い、既定はOFF。
fn situation_max_turns(room: &Value, situation: &Value, participant_count: usize) -> Option<usize> {
    if participant_count <= 1 {
        return Some(1);
    }
    if !boolean(situation, "limitTurns") {
        return None;
    }

    Some(
        room.get("maxMentionChain")
            .and_then(Value::as_u64)
            .or_else(|| situation.get("maxTurns").and_then(Value::as_u64))
            .unwrap_or(3)
            .clamp(1, SITUATION_TURN_CAP as u64) as usize,
    )
}

/// 会話の生成に使うモデル。キャラクターごとの指定はなく、全体設定の既定チャットモデルを使う。
fn chat_model_selection(payload: &Value) -> AppResult<RoleSelection> {
    resolve_role_selection(payload, "chatModel", "defaultChatModel")
}

/// 最新のユーザー発言で名前を呼ばれた参加者。複数いれば、文中で最初に出てきた人。
fn addressed_participant<'a>(history: &[Value], participants: &'a [Value]) -> Option<&'a Value> {
    let latest = history
        .last()
        .filter(|message| string(message, "role") == "user")?;
    let content = string(latest, "content");
    participants
        .iter()
        .filter_map(|actor| {
            let name = string(actor, "name");
            (!name.is_empty())
                .then(|| content.find(&name))
                .flatten()
                .map(|position| (position, actor))
        })
        .min_by_key(|(position, _)| *position)
        .map(|(_, actor)| actor)
}

pub async fn turn(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> AppResult<Json<Value>> {
    let TurnOutput { mut result, memory } =
        run_turn(state.clone(), payload.clone(), JobCancellation::default())
            .await
            .map_err(|failure| failure.error)?;
    let generated = result
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let extraction = match memory {
        Some(follow_up) => extract_turn_memories(&state, &payload, follow_up, &generated)
            .await
            .unwrap_or_default(),
        None => MemoryExtraction::default(),
    };
    if let Some(usages) = result.get_mut("usages").and_then(Value::as_array_mut) {
        usages.extend(extraction.usages);
    }
    result["memoryCandidates"] = Value::Array(extraction.candidates);
    Ok(Json(result))
}

pub(crate) struct ConversationTurnFailure {
    pub(crate) error: AppError,
    pub(crate) full_json_logs: Vec<Value>,
}

pub(crate) struct TurnOutput {
    pub(crate) result: Value,
    pub(crate) memory: Option<MemoryFollowUp>,
}

pub(crate) async fn run_turn(
    state: AppState,
    payload: Value,
    cancellation: JobCancellation,
) -> Result<TurnOutput, ConversationTurnFailure> {
    let secret_mode = payload
        .get("secretMode")
        .and_then(Value::as_bool)
        .or_else(|| payload.pointer("/room/secretMode").and_then(Value::as_bool))
        .unwrap_or(false);
    let mut full_json_logs = Vec::new();
    match run_turn_inner(
        state,
        payload,
        secret_mode,
        &mut full_json_logs,
        cancellation,
    )
    .await
    {
        Ok(result) => Ok(result),
        Err(error) => {
            if secret_mode {
                full_json_logs.clear();
            }
            Err(ConversationTurnFailure {
                error,
                full_json_logs,
            })
        }
    }
}

fn request_api_config(payload: &Value) -> AppResult<Option<AiApiConfig>> {
    ai_api_config_value(payload)
        .cloned()
        .map(serde_json::from_value::<AiApiConfig>)
        .transpose()
        .map_err(|error| AppError::BadRequest(format!("aiApiConfig が不正です: {error}")))
}

async fn run_turn_inner(
    state: AppState,
    payload: Value,
    secret_mode: bool,
    full_json_logs: &mut Vec<Value>,
    cancellation: JobCancellation,
) -> AppResult<TurnOutput> {
    let room = object_field(&payload, "room")?.clone();
    let generation_mode = GenerationMode::from_payload(&payload)?;
    let situation = payload.get("situation").filter(|value| value.is_object());
    let previous_summary = string(&room, "summary");
    let mut history = array_field_or(&payload, "messages", &room, "messages");
    let prior_message_count = situation
        .map(|situation| {
            prepend_situation_prior_messages(&mut history, situation, &previous_summary)
        })
        .unwrap_or(0);
    sanitize_assistant_history(&mut history);
    history.retain(|message| !boolean(message, "archived"));
    if history.is_empty() {
        return Err(AppError::BadRequest(
            "messages に会話履歴が必要です。".into(),
        ));
    }
    if generation_mode.is_continue()
        && history
            .last()
            .is_none_or(|message| string(message, "role") != "assistant")
    {
        return Err(AppError::BadRequest(
            "続きを生成するには直前のキャラクター返答が必要です。".into(),
        ));
    }

    let participants = payload
        .get("groupCharacters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let character = payload.get("character").filter(|value| value.is_object());
    if situation.is_none() && character.is_none() {
        return Err(AppError::BadRequest(
            "単体会話には character が必要です。".into(),
        ));
    }
    if situation.is_some() && participants.is_empty() {
        return Err(AppError::BadRequest(
            "シチュエーション会話には groupCharacters が必要です。".into(),
        ));
    }

    let mut clients = RequestClients::new(&state, request_api_config(&payload)?);

    let summary_character = if situation.is_some() {
        participants.first()
    } else {
        character
    };
    let summary_selection = optional_role_selection(&payload, "summaryModel", "summaryModel");
    let history_limit = situation
        .and_then(|value| value.get("maxHistory"))
        .and_then(Value::as_u64)
        .or_else(|| {
            summary_character
                .and_then(|value| value.get("maxHistory"))
                .and_then(Value::as_u64)
        })
        .map(|value| value.max(1) as usize)
        .unwrap_or(DEFAULT_MAX_HISTORY);
    let fallback_summary = (!previous_summary.is_empty()).then_some(previous_summary.clone());
    let summary_attempt = tokio::select! {
        biased;
        () = cancellation.cancelled() => Ok((fallback_summary.clone(), history.clone())),
        attempt = maybe_summarize(
            &mut clients,
            &history,
            previous_summary,
            boolean(&payload, "conversationCompressionEnabled"),
            history_limit,
            prior_message_count,
            situation.is_some(),
            summary_selection.as_ref(),
            situation,
            &participants,
        ) => attempt,
    };
    let (current_summary, active_history) = match summary_attempt {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!(
                classification = error.diagnostic_class(),
                "conversation summary failed; continuing with full history"
            );
            (fallback_summary.clone(), history.clone())
        }
    };
    let summary_result = if active_history.len() < history.len() {
        let summarized_count = history.len() - active_history.len();
        let checkpoint_user_message_id =
            summary_checkpoint_user_message_id(&history, summarized_count, prior_message_count);
        current_summary.as_ref().map(|summary| {
            let mut result = json!({
                "text": summary,
                "keepCount": active_history.len(),
            });
            if let (Some(object), Some(checkpoint)) =
                (result.as_object_mut(), checkpoint_user_message_id.as_ref())
            {
                object.insert(
                    "checkpointUserMessageId".to_owned(),
                    Value::String(checkpoint.clone()),
                );
            }
            result
        })
    } else {
        None
    };

    let room_id = string(&room, "id");
    let reply_format = ReplyFormat::from_view_mode(&string(&room, "viewMode"));
    let default_reasoning_effort =
        reasoning_effort_str(payload.get("reasoningEffort").and_then(Value::as_str));
    let preview_job_id = payload
        .get("streamingPreview")
        .and_then(Value::as_bool)
        .filter(|enabled| *enabled)
        .and_then(|_| payload.get("jobId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let streaming_preview = preview_job_id.map(|job_id| (&state.conversation_jobs, job_id));

    let mut generated = Vec::new();
    let mut usages = Vec::new();
    let mut used_memory_ids = Vec::new();
    let mut extraction_context: Option<ExtractionContext> = None;

    if let Some(situation) = situation {
        let max_turns = situation_max_turns(&room, situation, participants.len());
        let selection = chat_model_selection(&payload)?;
        let first_speaker = if generation_mode.is_continue() {
            None
        } else {
            addressed_participant(&active_history, &participants)
        };
        let ensemble_history = slice_by_user_history(&active_history, history_limit);
        let memory_enabled = !secret_mode && string(situation, "memoryMode") == "readOnly";
        let mut cast_memories = Vec::with_capacity(participants.len());
        for actor in &participants {
            let source_id = string(actor, "sourceCharacterId");
            let memory_allowed = memory_enabled
                && string(actor, "actorType") == "character"
                && !source_id.is_empty();
            let relevant = if memory_allowed {
                // 埋め込みモデルが未設定でも記憶検索は字句類似度だけで続行する。
                let embedding_selection = optional_role_selection(
                    &payload,
                    "memoryEmbeddingModel",
                    "memoryEmbeddingModel",
                );
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => Vec::new(),
                    memories = search_memories(
                        &state,
                        &mut clients,
                        embedding_selection.as_ref(),
                        &source_id,
                        &room_id,
                        &ensemble_history,
                    ) => memories.unwrap_or_default(),
                }
            } else {
                Vec::new()
            };
            extend_unique(
                &mut used_memory_ids,
                relevant.iter().map(|memory| memory.id.clone()),
            );
            cast_memories.push(relevant);
        }
        if !cancellation.is_cancelled() {
            let generation_history =
                with_continuation_trigger(ensemble_history, generation_mode.is_continue());
            generated = tokio::select! {
                biased;
                () = cancellation.cancelled() => Vec::new(),
                messages = generate_for_ensemble(
                    &mut clients,
                    EnsembleRequest {
                        selection: &selection,
                        sampling: chat_sampling(&payload),
                        reasoning_effort: default_reasoning_effort,
                        situation,
                        participants: &participants,
                        cast_memories: &cast_memories,
                        history: &generation_history,
                        room: &room,
                        summary: current_summary.as_deref(),
                        format: reply_format,
                        max_turns,
                        first_speaker,
                        narration: situation_narration_enabled(
                            situation,
                            &participants,
                            reply_format,
                        ),
                        secret_mode,
                        streaming_preview,
                    },
                    &mut usages,
                    full_json_logs,
                ) => messages?,
            };
        }
    } else if let Some(character) = character {
        let memory_allowed =
            !secret_mode && !matches!(character.get("enableMemory"), Some(Value::Bool(false)));
        let relevant = if memory_allowed {
            let embedding_selection =
                optional_role_selection(&payload, "memoryEmbeddingModel", "memoryEmbeddingModel");
            let memory_character_id = string(character, "id");
            tokio::select! {
                biased;
                () = cancellation.cancelled() => Vec::new(),
                memories = search_memories(
                    &state,
                    &mut clients,
                    embedding_selection.as_ref(),
                    &memory_character_id,
                    &room_id,
                    &active_history,
                ) => memories.unwrap_or_default(),
            }
        } else {
            Vec::new()
        };
        extend_unique(
            &mut used_memory_ids,
            relevant.iter().map(|memory| memory.id.clone()),
        );
        let selection = chat_model_selection(&payload)?;
        let character_history = with_continuation_trigger(
            slice_by_user_history(&active_history, history_limit),
            generation_mode.is_continue(),
        );
        generated = tokio::select! {
            biased;
            () = cancellation.cancelled() => Vec::new(),
            messages = generate_for_character(
                &mut clients,
                &selection,
                chat_sampling(&payload),
                character,
                &character_history,
                &room,
                current_summary.as_deref(),
                &relevant,
                reply_format,
                secret_mode,
                &mut usages,
                full_json_logs,
                0,
                streaming_preview,
                default_reasoning_effort,
            ) => messages?,
        };
        if memory_allowed && !cancellation.is_cancelled() {
            extraction_context = Some(ExtractionContext {
                character: character.clone(),
                recent_history: active_history.clone(),
                existing_memories: relevant,
            });
        }
    }

    mark_continuation_start(&mut generated, generation_mode.is_continue());

    let memory = match extraction_context.filter(|_| !secret_mode) {
        Some(context) => {
            let gate_enabled = payload
                .get("memoryGateEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let gate = if gate_enabled {
                let gate = tokio::select! {
                    biased;
                    () = cancellation.cancelled() => None,
                    decision = request_memory_gate(
                        &mut clients,
                        &payload,
                        &context,
                        &generated,
                        generation_mode.is_continue(),
                        &room,
                        &mut usages,
                        full_json_logs,
                    ) => decision,
                };
                if let Some(decision) = &gate {
                    apply_used_memory_ids(&mut generated, &decision.used_memory_ids);
                    used_memory_ids.clone_from(&decision.used_memory_ids);
                }
                gate
            } else {
                None
            };
            plan_memory_follow_up(
                context,
                gate,
                boolean(&payload, "memoryGateShadowMode"),
                gate_enabled,
            )
        }
        None => None,
    };

    if secret_mode {
        usages.clear();
        full_json_logs.clear();
        used_memory_ids.clear();
    }
    let full_json_logs = std::mem::take(full_json_logs);
    Ok(TurnOutput {
        result: json!({
            "messages": generated,
            "usages": usages,
            "fullJsonLogs": full_json_logs,
            "summary": summary_result,
            "usedMemoryIds": used_memory_ids,
        }),
        memory,
    })
}

struct GenerationDebugContext<'a> {
    room: &'a Value,
    character_id: String,
    character_name: String,
    model: String,
    prompt: &'a str,
}

fn error_http_status(error: &AppError) -> Option<u16> {
    match error {
        AppError::Upstream(_, status) => Some(status.as_u16()),
        AppError::Http(error) => error.status().map(|status| status.as_u16()),
        _ => None,
    }
}

fn is_response_parse_error(error: &AppError) -> bool {
    match error {
        AppError::Json(_) => true,
        AppError::Http(error) => error.is_decode() || error.is_body(),
        AppError::Upstream(message, status) => {
            *status == axum::http::StatusCode::BAD_GATEWAY
                && (message.contains("JSON") || message.contains("解析"))
        }
        _ => false,
    }
}

fn chat_error_source(error: &AppError) -> &'static str {
    if is_response_parse_error(error) {
        "chat-response-parse-error"
    } else if matches!(error, AppError::Upstream(..) | AppError::Http(_)) {
        "chat-http-error"
    } else {
        "chat-error"
    }
}

fn push_error_debug_log(
    logs: &mut Vec<Value>,
    context: &GenerationDebugContext<'_>,
    source: &str,
    response_text: Option<&str>,
    reasoning: Option<&str>,
    error: &AppError,
    elapsed_ms: u64,
) {
    let output = response_text
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            serde_json::to_string_pretty(&json!({
                "error": error.to_string(),
                "classification": error.diagnostic_class(),
            }))
            .expect("debug error must be serializable")
        });
    let mut log = json!({
        "roomId": string(context.room, "id"),
        "roomName": string(context.room, "name"),
        "characterId": context.character_id,
        "characterName": context.character_name,
        "model": context.model,
        "status": "error",
        "source": source,
        "prompt": context.prompt,
        "json": output,
        "elapsedMs": elapsed_ms,
        "errorName": error.diagnostic_class(),
    });
    if let Some(reasoning) = reasoning.filter(|value| !value.trim().is_empty()) {
        log["reasoning"] = json!(reasoning);
    }
    if let Some(status) = error_http_status(error) {
        log["httpStatus"] = json!(status);
    }
    push_debug_log(logs, log);
}

// 添付画像の data URL が入るとログ1件が数十MBになるため、表示・保持用の
// 文字列フィールドにある base64 ペイロードだけをプレースホルダーに置き換える。
const DEBUG_LOG_REDACTED_KEYS: [&str; 4] = ["prompt", "json", "reasoning", "secondJson"];

fn push_debug_log(logs: &mut Vec<Value>, mut log: Value) {
    if let Some(object) = log.as_object_mut() {
        for key in DEBUG_LOG_REDACTED_KEYS {
            let Some(text) = object.get(key).and_then(Value::as_str) else {
                continue;
            };
            let redacted = redact_base64_data_urls(text);
            if redacted != text {
                object.insert(key.to_owned(), Value::String(redacted));
            }
        }
    }
    logs.push(log);
}

/// デバッグログの `usage` に載せるトークン数・コスト・スループットの元データ。
#[derive(Default)]
struct DebugUsageInput {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: Option<u64>,
    cost: Option<f64>,
    /// リクエスト開始から完了までの経過時間。
    elapsed_ms: u64,
    /// 最初のトークンが届くまでの時間。ストリーミング時のみ測れる。
    first_token_ms: Option<u64>,
    /// 最初のトークンから最後のトークンまでのデコード区間。
    decode_ms: Option<u64>,
    provider_tokens_per_second: Option<f64>,
    provider_prompt_tokens_per_second: Option<f64>,
    /// 出力トークン数がサーバー値ではなく概算か。
    estimated_completion_tokens: bool,
}

/// デバッグログの `usage` に載せるトークン数・コスト・スループット。
/// 使用量がひとつも取れないときは `None` を返し、空の統計をログへ足さない。
fn token_debug_usage(input: DebugUsageInput) -> Option<Value> {
    if input.prompt_tokens == 0
        && input.completion_tokens == 0
        && input.total_tokens.unwrap_or(0) == 0
    {
        return None;
    }
    let total_tokens = input
        .total_tokens
        .filter(|total| *total > 0)
        .unwrap_or(input.prompt_tokens + input.completion_tokens);
    let mut usage = json!({
        "promptTokens": input.prompt_tokens,
        "completionTokens": input.completion_tokens,
        "totalTokens": total_tokens,
    });
    if let Some(cost) = input.cost.filter(|cost| *cost > 0.0) {
        usage["cost"] = json!(cost);
    }
    if input.estimated_completion_tokens {
        usage["estimated"] = json!(true);
    }
    // 生成速度は出力トークンだけで測る。プロバイダの実測値 → ストリームの
    // デコード区間 → 全体の経過時間、の順に信頼できる値を使う。概算トークン数を
    // 全体の経過時間で割るとプロンプト処理まで含んでしまうため、最後の手段にしない。
    let decode_tokens_per_second = input
        .decode_ms
        .filter(|decode_ms| *decode_ms > 0)
        .map(|decode_ms| input.completion_tokens as f64 * 1000.0 / decode_ms as f64);
    let elapsed_tokens_per_second =
        (!input.estimated_completion_tokens && input.elapsed_ms > 0 && input.completion_tokens > 0)
            .then(|| input.completion_tokens as f64 * 1000.0 / input.elapsed_ms as f64);
    if let Some(tokens_per_second) = input
        .provider_tokens_per_second
        .or(decode_tokens_per_second)
        .or(elapsed_tokens_per_second)
        .filter(|value| value.is_finite() && *value > 0.0)
    {
        usage["tokensPerSecond"] = json!((tokens_per_second * 10.0).round() / 10.0);
    }
    if let Some(first_token_ms) = input.first_token_ms.filter(|value| *value > 0) {
        usage["timeToFirstTokenMs"] = json!(first_token_ms);
    }
    // プロンプト処理の速度。TTFT には通信と待ち行列も含むため参考値。
    let prompt_tokens_per_second = input.provider_prompt_tokens_per_second.or_else(|| {
        input
            .first_token_ms
            .filter(|first_token_ms| *first_token_ms > 0 && input.prompt_tokens > 0)
            .map(|first_token_ms| input.prompt_tokens as f64 * 1000.0 / first_token_ms as f64)
    });
    if let Some(prompt_tokens_per_second) =
        prompt_tokens_per_second.filter(|value| value.is_finite() && *value > 0.0)
    {
        usage["promptTokensPerSecond"] = json!((prompt_tokens_per_second * 10.0).round() / 10.0);
    }
    Some(usage)
}

/// ストリーミング時に測った、最初のトークンまでの時間とデコード区間。
#[derive(Default, Clone, Copy)]
struct CompletionTimings {
    first_token_ms: Option<u64>,
    decode_ms: Option<u64>,
}

fn completion_timings(raw: &Value) -> CompletionTimings {
    let timings = raw.get("kataruTimings");
    CompletionTimings {
        first_token_ms: timings
            .and_then(|timings| timings.get("firstTokenMs"))
            .and_then(Value::as_u64),
        decode_ms: timings
            .and_then(|timings| timings.get("decodeMs"))
            .and_then(Value::as_u64),
    }
}

/// llama.cpp (`timings`) や LM Studio (`stats`) が返す、サーバー側の実測速度。
fn provider_tokens_per_second(raw: &Value) -> Option<f64> {
    raw.pointer("/timings/predicted_per_second")
        .and_then(Value::as_f64)
        .or_else(|| {
            raw.pointer("/stats/tokens_per_second")
                .and_then(Value::as_f64)
        })
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn provider_prompt_tokens_per_second(raw: &Value) -> Option<f64> {
    raw.pointer("/timings/prompt_per_second")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
}

/// トークナイザを持たないローカルサーバー向けの概算。日本語・中国語は
/// ほぼ1文字1トークン、ラテン文字などは約4文字1トークンとして数える。
fn estimate_completion_tokens(text: &str) -> u64 {
    let mut tokens = 0.0f64;
    for character in text.chars() {
        tokens += if is_wide_character(character) {
            1.0
        } else {
            0.25
        };
    }
    tokens.round() as u64
}

fn is_wide_character(character: char) -> bool {
    matches!(
        character as u32,
        0x3000..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF
    )
}

/// OpenAI互換の応答からデバッグログ用の使用量を取り出す。
fn completion_debug_usage(raw: &Value, elapsed_ms: u64) -> Option<Value> {
    let usage = raw.get("usage").filter(|usage| usage.is_object());
    let mut prompt_tokens = usage
        .and_then(|usage| usage.get("prompt_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if prompt_tokens == 0 {
        prompt_tokens = raw
            .pointer("/timings/prompt_n")
            .and_then(Value::as_u64)
            .unwrap_or(0);
    }
    let mut completion_tokens = usage
        .and_then(|usage| usage.get("completion_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if completion_tokens == 0 {
        completion_tokens = raw
            .pointer("/timings/predicted_n")
            .and_then(Value::as_u64)
            .unwrap_or(0);
    }
    let mut estimated_completion_tokens = false;
    if completion_tokens == 0 {
        // ローカルサーバーは usage を返さないことがある。その場合は出力本文と
        // 推論から概算し、推定であることをログに残す。
        let mut generated = extract_message_text(raw);
        if let Some(reasoning) = extract_message_reasoning(raw) {
            generated.push_str(&reasoning);
        }
        let estimated = estimate_completion_tokens(&generated);
        if estimated > 0 {
            completion_tokens = estimated;
            estimated_completion_tokens = true;
        }
    }
    let timings = completion_timings(raw);
    token_debug_usage(DebugUsageInput {
        prompt_tokens,
        completion_tokens,
        total_tokens: usage
            .and_then(|usage| usage.get("total_tokens"))
            .and_then(Value::as_u64),
        cost: usage
            .and_then(|usage| usage.get("cost"))
            .and_then(Value::as_f64),
        elapsed_ms,
        first_token_ms: timings.first_token_ms,
        decode_ms: timings.decode_ms,
        provider_tokens_per_second: provider_tokens_per_second(raw),
        provider_prompt_tokens_per_second: provider_prompt_tokens_per_second(raw),
        estimated_completion_tokens,
    })
}

/// Jev (System One) の応答からデバッグログ用の使用量を取り出す。
fn jev_debug_usage(response: &SystemOneResponse, elapsed_ms: u64) -> Option<Value> {
    let usage = response.usage.as_ref()?;
    token_debug_usage(DebugUsageInput {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        elapsed_ms,
        ..Default::default()
    })
}

/// デバッグログ本体へ使用量を差し込む。
fn insert_debug_usage(log: &mut Value, key: &str, usage: Option<Value>) {
    let (Some(log), Some(usage)) = (log.as_object_mut(), usage) else {
        return;
    };
    log.insert(key.to_owned(), usage);
}

/// `data:<mediatype>;base64,<payload>` のペイロード部分を `[base64省略:Nchars]`
/// に置き換える。JSON文字列内では `"`・`\`・空白が必ず区切りになる。
fn redact_base64_data_urls(text: &str) -> String {
    if !text.contains(";base64,") {
        return text.to_owned();
    }
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_at) = rest.find("data:") {
        let head_end = scheme_at + "data:".len();
        let segment_end = rest[head_end..]
            .find(|c: char| matches!(c, '"' | '\'' | '\\') || c.is_whitespace())
            .map(|offset| head_end + offset)
            .unwrap_or(rest.len());
        let comma_at = rest[head_end..segment_end]
            .find(',')
            .map(|offset| head_end + offset);
        let base64_meta = comma_at
            .is_some_and(|comma_at| rest[head_end..comma_at].rsplit(';').next() == Some("base64"));
        if !base64_meta {
            result.push_str(&rest[..head_end]);
            rest = &rest[head_end..];
            continue;
        }
        let payload_start = comma_at.expect("checked above") + 1;
        let payload_len = rest[payload_start..]
            .find(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '+' | '/' | '='))
            .unwrap_or(rest.len() - payload_start);
        if payload_len == 0 {
            result.push_str(&rest[..payload_start]);
            rest = &rest[payload_start..];
            continue;
        }
        result.push_str(&rest[..payload_start]);
        result.push_str(&format!("[base64省略:{payload_len}chars]"));
        rest = &rest[payload_start + payload_len..];
    }
    result.push_str(rest);
    result
}

/// 会話用の生成パラメータ（全体設定の `chatSampling`）。未送信なら空のオブジェクト扱い。
fn chat_sampling(payload: &Value) -> &Value {
    static EMPTY: Value = Value::Null;
    payload
        .get("chatSampling")
        .filter(|value| value.is_object())
        .unwrap_or(&EMPTY)
}

fn chat_completion_body(
    model: &str,
    messages: Vec<Value>,
    sampling: &Value,
    reasoning_effort: Option<&str>,
    max_tokens: u64,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": number_f64(sampling, "temperature", DEFAULT_TEMPERATURE),
        "top_p": number_f64(sampling, "topP", DEFAULT_TOP_P),
        "top_k": number_u64(sampling, "topK", DEFAULT_TOP_K),
        "stream": false,
    });
    // 未設定のペナルティは送らず、プロバイダの既定値に任せる。
    for (setting, parameter) in [
        ("frequencyPenalty", "frequency_penalty"),
        ("presencePenalty", "presence_penalty"),
        ("repetitionPenalty", "repetition_penalty"),
    ] {
        if let Some(value) = sampling.get(setting).filter(|value| value.is_number()) {
            body[parameter] = value.clone();
        }
    }
    if let Some(effort) = reasoning_effort {
        body["reasoningEffort"] = json!(effort);
    }
    body
}

#[allow(clippy::too_many_arguments)]
async fn generate_for_character(
    clients: &mut RequestClients<'_>,
    selection: &RoleSelection,
    sampling: &Value,
    character: &Value,
    history: &[Value],
    room: &Value,
    summary: Option<&str>,
    memories: &[ScoredMemory],
    format: ReplyFormat,
    secret_mode: bool,
    usages: &mut Vec<Value>,
    full_json_logs: &mut Vec<Value>,
    id_offset: usize,
    streaming_preview: Option<(&ConversationJobs, &str)>,
    default_reasoning_effort: Option<&str>,
) -> AppResult<Vec<Value>> {
    let api_client = clients.for_selection(selection)?;
    let message_mode = format.is_message();
    // ベーシックだけが構造化出力を使わない。ゲームの表情・モーションはJSON前提。
    let plain_text = format == ReplyFormat::PlainText;
    let visual_novel_mode = format.is_structured();
    let expression_names = expression_names(character, room, visual_novel_mode);
    let motion_names = motion_names(character, room, visual_novel_mode);
    let max_characters = character_max_characters(character);
    let injected_memories = injected_memories(memories);
    let system_prompt = character_system_prompt(
        character,
        format,
        &expression_names,
        &motion_names,
        summary,
        &injected_memories,
        selected_costume(character, room),
    );
    let mut request_messages = vec![json!({
        "role": "system",
        "content": system_prompt,
    })];
    request_messages.extend(history.iter().map(|message| {
        json!({
            "role": string(message, "role"),
            "content": history_message_content(message),
        })
    }));
    let body = chat_completion_body(
        &selection.model,
        request_messages,
        sampling,
        default_reasoning_effort,
        CHAT_COMPLETION_MAX_TOKENS,
    );
    let prompt = api_client.resolve_user_placeholders(
        &serde_json::to_string_pretty(&body["messages"])
            .expect("completion messages must be serializable"),
    );
    let started = now_ms();
    let debug_context = GenerationDebugContext {
        room,
        character_id: actor_id(character),
        character_name: string(character, "name"),
        model: selection.model.clone(),
        prompt: &prompt,
    };
    let mut partial_content = String::new();
    let completion = if plain_text {
        let on_content = |partial: &str| {
            partial_content.clear();
            partial_content.push_str(partial);
            if let Some((jobs, job_id)) = streaming_preview {
                jobs.update_preview(
                    job_id,
                    &plain_response_preview(partial, max_characters),
                    &debug_context.character_id,
                    &debug_context.character_name,
                    None,
                    None,
                    None,
                );
            }
        };
        if streaming_preview.is_some() {
            plain_text_completion_streaming(&api_client, body, 120, on_content).await
        } else {
            plain_text_completion(&api_client, body, 120).await
        }
    } else {
        let schema = assistant_schema(
            &expression_names,
            &motion_names,
            message_mode,
            max_characters,
        );
        if let Some((jobs, job_id)) = streaming_preview {
            structured_completion_streaming(&api_client, body, schema, 120, |partial| {
                partial_content.clear();
                partial_content.push_str(partial);
                let preview = assistant_response_preview(partial, message_mode, max_characters);
                jobs.update_preview(
                    job_id,
                    &preview.content,
                    &debug_context.character_id,
                    &debug_context.character_name,
                    // メッセージモードでは閉じたバブルを確定済みとして流し、
                    // 一文字ずつの更新ではなく送信済みメッセージとして見せる。
                    message_mode.then_some(preview.confirmed_messages.as_slice()),
                    assistant_expression_preview(partial, &expression_names).as_deref(),
                    assistant_motion_preview(partial, &motion_names).as_deref(),
                );
            })
            .await
        } else {
            structured_completion(&api_client, body, schema, 120).await
        }
    };
    let raw = match completion {
        Ok(raw) => raw,
        Err(error) => {
            if !secret_mode {
                push_error_debug_log(
                    full_json_logs,
                    &debug_context,
                    chat_error_source(&error),
                    Some(&partial_content),
                    None,
                    &error,
                    now_ms().saturating_sub(started),
                );
            }
            return Err(error);
        }
    };
    let content = extract_message_text(&raw);
    let envelope = if plain_text {
        plain_assistant_response(&content, max_characters)
    } else {
        match parse_assistant_response(&content, &expression_names, &motion_names, message_mode) {
            Ok(envelope) => limit_assistant_reply_characters(envelope, max_characters),
            Err(error) => {
                if !secret_mode {
                    push_error_debug_log(
                        full_json_logs,
                        &debug_context,
                        "chat-response-parse-error",
                        Some(&content),
                        extract_message_reasoning(&raw).as_deref(),
                        &error,
                        now_ms().saturating_sub(started),
                    );
                }
                return Err(error);
            }
        }
    };
    if let Some((jobs, job_id)) = streaming_preview {
        jobs.finalize_preview(
            job_id,
            &envelope.message,
            &actor_id(character),
            &string(character, "name"),
            &envelope.messages,
            envelope.expression.as_deref(),
            envelope.motion.as_deref(),
        )
        .await;
    }
    if !secret_mode {
        push_usage_with_id(
            usages,
            &raw,
            &usage_character_id(character),
            &selection.model,
            "chat",
        );
        push_success_debug_log(
            full_json_logs,
            &debug_context,
            &raw,
            &content,
            if plain_text {
                "assistant-text"
            } else {
                "assistant-json"
            },
            started,
        );
    }
    Ok(envelope_to_messages(
        envelope,
        character,
        message_mode,
        id_offset,
        &memories
            .iter()
            .map(|memory| memory.id.clone())
            .collect::<Vec<_>>(),
    ))
}

fn injected_memories(memories: &[ScoredMemory]) -> Vec<InjectedMemory> {
    memories
        .iter()
        .map(|memory| InjectedMemory {
            content: memory.content.clone(),
            date_label: memory_date::memory_occurred_at(&memory.data)
                .and_then(|occurred_at| memory_date::date_label(occurred_at, now_ms() as i64)),
        })
        .collect()
}

fn push_success_debug_log(
    full_json_logs: &mut Vec<Value>,
    context: &GenerationDebugContext<'_>,
    raw: &Value,
    content: &str,
    source: &str,
    started: u64,
) {
    let elapsed_ms = now_ms().saturating_sub(started);
    let mut log = json!({
        "roomId": string(context.room, "id"),
        "roomName": string(context.room, "name"),
        "characterId": context.character_id,
        "characterName": context.character_name,
        "model": context.model,
        "status": "success",
        "source": source,
        "prompt": context.prompt,
        "json": content,
        "elapsedMs": elapsed_ms,
    });
    if let Some(reasoning) = extract_message_reasoning(raw) {
        log["reasoning"] = json!(reasoning);
    }
    insert_debug_usage(&mut log, "usage", completion_debug_usage(raw, elapsed_ms));
    push_debug_log(full_json_logs, log);
}

/// 一括生成1回分の入力。
struct EnsembleRequest<'a> {
    selection: &'a RoleSelection,
    sampling: &'a Value,
    reasoning_effort: Option<&'a str>,
    situation: &'a Value,
    participants: &'a [Value],
    /// `participants` と同じ順の、参加者ごとの関連記憶。
    cast_memories: &'a [Vec<ScoredMemory>],
    history: &'a [Value],
    room: &'a Value,
    summary: Option<&'a str>,
    format: ReplyFormat,
    /// `None` は上限なし（内部では `SITUATION_TURN_CAP` まで）。
    max_turns: Option<usize>,
    first_speaker: Option<&'a Value>,
    /// 場面全体のナレーションを `narrator` のturnに分けるか。
    narration: bool,
    secret_mode: bool,
    streaming_preview: Option<(&'a ConversationJobs, &'a str)>,
}

/// 発言数が増えるほど出力も長くなるので、上限トークンと待ち時間を発言数に合わせて広げる。
fn ensemble_max_tokens(max_turns: usize, narration: bool) -> u64 {
    let extra_turns = max_turns.saturating_sub(1) as u64;
    let narration_tokens = if narration { 512 } else { 0 };
    (CHAT_COMPLETION_MAX_TOKENS + extra_turns * 1024 + narration_tokens).min(8192)
}

/// シチュエーションでナレーションを分けるか。メッセージ形式では使わず、
/// 参加者のidが予約idと重なる場合も区別できないので無効にする。
fn situation_narration_enabled(
    situation: &Value,
    participants: &[Value],
    format: ReplyFormat,
) -> bool {
    boolean(situation, "separateNarration")
        && !format.is_message()
        && participants
            .iter()
            .all(|actor| actor_id(actor) != NARRATOR_ID)
}

fn ensemble_timeout_secs(max_turns: usize) -> u64 {
    let extra_turns = max_turns.saturating_sub(1) as u64;
    (120 + extra_turns * 30).min(300)
}

fn unique_names(lists: impl IntoIterator<Item = Vec<String>>) -> Vec<String> {
    let mut seen = HashSet::new();
    lists
        .into_iter()
        .flatten()
        .filter(|name| seen.insert(name.clone()))
        .collect()
}

/// 会話履歴を一括生成用のメッセージ列にする。続けて並ぶキャラクター発言は、
/// 出力と同じ `{"turns": [...]}` 形式の1つの assistant メッセージにまとめて書き戻す。
fn ensemble_request_history(history: &[Value], message_mode: bool) -> Vec<Value> {
    fn flush(output: &mut Vec<Value>, turns: &mut Vec<Value>) {
        if turns.is_empty() {
            return;
        }
        let content = json!({ "turns": std::mem::take(turns) }).to_string();
        output.push(json!({ "role": "assistant", "content": content }));
    }

    let mut output = Vec::new();
    let mut turns: Vec<Value> = Vec::new();
    for message in history {
        if string(message, "role") != "assistant" {
            flush(&mut output, &mut turns);
            output.push(json!({
                "role": string(message, "role"),
                "content": history_message_content(message),
            }));
            continue;
        }
        let speaker = string(message, "characterId");
        let content = history_content(message);
        if content.is_empty() {
            continue;
        }
        let same_speaker = turns
            .last()
            .is_some_and(|turn| turn.get("speaker").and_then(Value::as_str) == Some(&speaker));
        match (same_speaker, message_mode) {
            (true, true) => {
                if let Some(messages) = turns
                    .last_mut()
                    .and_then(|turn| turn.get_mut("messages"))
                    .and_then(Value::as_array_mut)
                {
                    messages.push(Value::String(content));
                }
            }
            (true, false) => {
                if let Some(Value::String(existing)) =
                    turns.last_mut().and_then(|turn| turn.get_mut("message"))
                {
                    existing.push_str("\n\n");
                    existing.push_str(&content);
                }
            }
            (false, true) => turns.push(json!({ "speaker": speaker, "messages": [content] })),
            (false, false) => turns.push(json!({ "speaker": speaker, "message": content })),
        }
    }
    flush(&mut output, &mut turns);
    output
}

fn ensemble_preview_turns(
    previews: &[EnsembleTurnPreview],
    names: &HashMap<String, String>,
    message_mode: bool,
) -> Vec<Value> {
    previews
        .iter()
        .enumerate()
        .map(|(index, preview)| {
            let mut turn = json!({
                "turnIndex": index,
                "content": preview.content,
                "characterId": preview.speaker,
                "characterName": names.get(&preview.speaker).cloned().unwrap_or_default(),
                "complete": preview.complete,
            });
            if preview.complete {
                turn["formattedMessages"] = json!(preview.messages);
            } else if message_mode {
                turn["confirmedMessages"] = json!(preview.messages);
            }
            if let Some(expression) = &preview.expression {
                turn["expression"] = Value::String(expression.clone());
            }
            if let Some(motion) = &preview.motion {
                turn["motion"] = Value::String(motion.clone());
            }
            turn
        })
        .collect()
}

/// シチュエーションの1ターンを、1回の呼び出しで複数キャラクターぶんまとめて生成する。
async fn generate_for_ensemble(
    clients: &mut RequestClients<'_>,
    request: EnsembleRequest<'_>,
    usages: &mut Vec<Value>,
    full_json_logs: &mut Vec<Value>,
) -> AppResult<Vec<Value>> {
    let EnsembleRequest {
        selection,
        sampling,
        reasoning_effort,
        situation,
        participants,
        cast_memories,
        history,
        room,
        summary,
        format,
        max_turns,
        first_speaker,
        narration,
        secret_mode,
        streaming_preview,
    } = request;
    let api_client = clients.for_selection(selection)?;
    let turn_cap = max_turns.unwrap_or(SITUATION_TURN_CAP);
    let message_mode = format.is_message();
    let visual_novel_mode = format.is_structured();
    let mut speakers = participants
        .iter()
        .map(|actor| EnsembleSpeaker {
            id: actor_id(actor),
            expression_names: expression_names(actor, room, visual_novel_mode),
            motion_names: motion_names(actor, room, visual_novel_mode),
            max_characters: character_max_characters(actor),
        })
        .collect::<Vec<_>>();
    let max_characters = speakers
        .iter()
        .map(|speaker| speaker.max_characters)
        .max()
        .unwrap_or(DEFAULT_MAX_CHARACTERS as usize);
    if narration {
        // 参加者の後ろに置くので、参加者と順に対応させる `cast` には含まれない。
        speakers.push(EnsembleSpeaker {
            id: NARRATOR_ID.to_owned(),
            expression_names: Vec::new(),
            motion_names: Vec::new(),
            max_characters,
        });
    }
    let names = participants
        .iter()
        .map(|actor| (actor_id(actor), string(actor, "name")))
        .chain(narration.then(|| (NARRATOR_ID.to_owned(), String::new())))
        .collect::<HashMap<_, _>>();
    let cast = participants
        .iter()
        .zip(&speakers)
        .enumerate()
        .map(|(index, (actor, speaker))| EnsembleCast {
            actor,
            expression_names: speaker.expression_names.clone(),
            motion_names: speaker.motion_names.clone(),
            memories: cast_memories
                .get(index)
                .map(|memories| injected_memories(memories))
                .unwrap_or_default(),
            costume: selected_costume(actor, room),
        })
        .collect::<Vec<_>>();
    let system_prompt = ensemble_system_prompt(
        situation,
        &cast,
        format,
        max_turns,
        first_speaker,
        summary,
        narration,
    );
    let schema = ensemble_schema(
        &speakers
            .iter()
            .map(|speaker| speaker.id.clone())
            .collect::<Vec<_>>(),
        &unique_names(
            speakers
                .iter()
                .map(|speaker| speaker.expression_names.clone()),
        ),
        &unique_names(speakers.iter().map(|speaker| speaker.motion_names.clone())),
        format,
        max_characters,
        ensemble_max_items(turn_cap, narration),
    );
    let mut request_messages = vec![json!({
        "role": "system",
        "content": system_prompt,
    })];
    request_messages.extend(ensemble_request_history(history, message_mode));
    let body = chat_completion_body(
        &selection.model,
        request_messages,
        sampling,
        reasoning_effort,
        ensemble_max_tokens(turn_cap, narration),
    );
    let prompt = api_client.resolve_user_placeholders(
        &serde_json::to_string_pretty(&body["messages"])
            .expect("completion messages must be serializable"),
    );
    let started = now_ms();
    let debug_context = GenerationDebugContext {
        room,
        character_id: string(situation, "id"),
        character_name: string(situation, "name"),
        model: selection.model.clone(),
        prompt: &prompt,
    };
    let timeout = ensemble_timeout_secs(turn_cap);
    let mut partial_content = String::new();
    let completion = if let Some((jobs, job_id)) = streaming_preview {
        structured_completion_streaming(&api_client, body, schema, timeout, |partial| {
            partial_content.clear();
            partial_content.push_str(partial);
            let previews = ensemble_response_preview(partial, &speakers, message_mode);
            jobs.replace_preview_turns(
                job_id,
                ensemble_preview_turns(&previews, &names, message_mode),
            );
        })
        .await
    } else {
        structured_completion(&api_client, body, schema, timeout).await
    };
    let raw = match completion {
        Ok(raw) => raw,
        Err(error) => {
            if !secret_mode {
                push_error_debug_log(
                    full_json_logs,
                    &debug_context,
                    chat_error_source(&error),
                    Some(&partial_content),
                    None,
                    &error,
                    now_ms().saturating_sub(started),
                );
            }
            return Err(error);
        }
    };
    let content = extract_message_text(&raw);
    let turns = match parse_ensemble_response(&content, &speakers, message_mode, turn_cap) {
        Ok(turns) => turns,
        Err(error) => {
            if !secret_mode {
                push_error_debug_log(
                    full_json_logs,
                    &debug_context,
                    "chat-response-parse-error",
                    Some(&content),
                    extract_message_reasoning(&raw).as_deref(),
                    &error,
                    now_ms().saturating_sub(started),
                );
            }
            return Err(error);
        }
    };
    if let Some((jobs, job_id)) = streaming_preview {
        let previews = turns
            .iter()
            .map(|turn| EnsembleTurnPreview {
                speaker: turn.speaker.clone(),
                complete: true,
                content: turn.envelope.message.clone(),
                messages: turn.envelope.messages.clone(),
                expression: turn.envelope.expression.clone(),
                motion: turn.envelope.motion.clone(),
            })
            .collect::<Vec<_>>();
        jobs.finalize_preview_turns(
            job_id,
            ensemble_preview_turns(&previews, &names, message_mode),
        )
        .await;
    }
    if !secret_mode {
        push_usage_with_id(
            usages,
            &raw,
            &string(situation, "id"),
            &selection.model,
            "chat",
        );
        push_success_debug_log(
            full_json_logs,
            &debug_context,
            &raw,
            &content,
            "assistant-json",
            started,
        );
    }
    let mut messages = Vec::new();
    let narrator = json!({ "id": NARRATOR_ID });
    for turn in turns {
        if turn.speaker == NARRATOR_ID {
            let offset = messages.len();
            let mut envelope = turn.envelope;
            envelope.expression = None;
            envelope.motion = None;
            messages.extend(envelope_to_messages(
                envelope,
                &narrator,
                message_mode,
                offset,
                &[],
            ));
            continue;
        }
        let Some(index) = participants
            .iter()
            .position(|actor| actor_id(actor) == turn.speaker)
        else {
            continue;
        };
        let used_memory_ids = cast_memories
            .get(index)
            .map(|memories| {
                memories
                    .iter()
                    .map(|memory| memory.id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let offset = messages.len();
        messages.extend(envelope_to_messages(
            turn.envelope,
            &participants[index],
            message_mode,
            offset,
            &used_memory_ids,
        ));
    }
    Ok(messages)
}

fn envelope_to_messages(
    envelope: AssistantEnvelope,
    character: &Value,
    message_mode: bool,
    id_offset: usize,
    used_memory_ids: &[String],
) -> Vec<Value> {
    let contents = if message_mode {
        envelope.messages
    } else {
        vec![envelope.message]
    };
    let actor = actor_id(character);
    let timestamp = now_ms();
    contents
        .into_iter()
        .enumerate()
        .map(|(index, content)| {
            let mut message = Map::new();
            message.insert(
                "id".into(),
                Value::String(format!("rust-{timestamp}-{}", id_offset + index)),
            );
            message.insert("role".into(), Value::String("assistant".into()));
            message.insert("content".into(), Value::String(content));
            message.insert("characterId".into(), Value::String(actor.clone()));
            message.insert("toCharacterIds".into(), Value::Array(Vec::new()));
            if !used_memory_ids.is_empty() {
                message.insert("usedMemoryIds".into(), json!(used_memory_ids));
            }
            message.insert(
                "timestamp".into(),
                json!(timestamp + (id_offset + index) as u64),
            );
            if index == 0
                && let Some(expression) = &envelope.expression
            {
                message.insert("expression".into(), Value::String(expression.clone()));
            }
            if index == 0
                && let Some(motion) = &envelope.motion
            {
                message.insert("motion".into(), Value::String(motion.clone()));
            }
            Value::Object(message)
        })
        .collect()
}

fn push_jev_usage(
    usages: &mut Vec<Value>,
    response: &SystemOneResponse,
    character_id: &str,
    model: &str,
    source: &str,
) {
    let Some(usage) = &response.usage else {
        return;
    };
    usages.push(json!({
        "id": format!("usage-{}", now_ms()),
        "characterId": character_id,
        "model": model,
        "source": source,
        "promptTokens": usage.input_tokens,
        "completionTokens": usage.output_tokens,
        "totalTokens": usage.input_tokens + usage.output_tokens,
        "cost": 0.0,
        "timestamp": now_ms(),
    }));
}

#[allow(clippy::too_many_arguments)]
async fn maybe_summarize(
    clients: &mut RequestClients<'_>,
    history: &[Value],
    previous_summary: String,
    enabled: bool,
    history_limit: usize,
    prior_message_count: usize,
    group: bool,
    selection: Option<&RoleSelection>,
    situation: Option<&Value>,
    participants: &[Value],
) -> AppResult<(Option<String>, Vec<Value>)> {
    let existing = (!previous_summary.is_empty()).then_some(previous_summary);
    if !enabled || count_user_messages(history) <= history_limit {
        return Ok((existing, history.to_vec()));
    }
    let cut = summary_cut(history, prior_message_count);
    let to_summarize = &history[..cut];
    if to_summarize.len() < 2 {
        return Ok((existing, history.to_vec()));
    }
    let selection = selection.ok_or_else(|| {
        AppError::BadRequest(
            "summaryModel または aiApiConfig.modelDefaults.summaryModel が必要です。".to_owned(),
        )
    })?;
    let api_client = clients.for_selection(selection)?;
    let named_messages = if group {
        with_speaker_names(to_summarize, participants, situation)
    } else {
        to_summarize.to_vec()
    };
    let (system, user) = summary_prompts(&named_messages, existing.as_deref(), group);
    let raw = structured_completion(
        &api_client,
        json!({
            "model": selection.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": 2048,
            "reasoningEffort": "low",
            "stream": false,
        }),
        summary_schema(),
        120,
    )
    .await?;
    let summary = parse_summary_response(&extract_message_text(&raw));
    if summary.is_empty() {
        return Ok((existing, history.to_vec()));
    }
    Ok((Some(summary), history[cut..].to_vec()))
}

#[derive(Clone)]
struct ScoredMemory {
    id: String,
    content: String,
    data: Value,
    score: f64,
}

async fn search_memories(
    state: &AppState,
    clients: &mut RequestClients<'_>,
    selection: Option<&RoleSelection>,
    character_id: &str,
    room_id: &str,
    messages: &[Value],
) -> AppResult<Vec<ScoredMemory>> {
    // 埋め込みモデルが未設定なら接続も作らず、字句類似度だけで採点する。
    let api_client = selection
        .map(|selection| clients.for_selection(selection))
        .transpose()?;
    if character_id.is_empty() {
        return Ok(Vec::new());
    }
    let id = character_id.to_owned();
    let rows: Vec<Value> = state
        .database
        .call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT data_json FROM memories WHERE character_id = ?1 ORDER BY updated_at DESC",
            )?;
            let values = statement
                .query_map([id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            values
                .into_iter()
                .map(|raw| serde_json::from_str::<Value>(&raw).map_err(AppError::from))
                .collect()
        })
        .await?;
    let query = messages
        .iter()
        .rev()
        .find(|message| string(message, "role") == "user")
        .map(|message| message_text_with_attachments(message, true))
        .unwrap_or_else(|| {
            messages
                .iter()
                .map(|message| message_text_with_attachments(message, true))
                .collect::<Vec<_>>()
                .join("\n")
        });
    let recent_ids = messages
        .iter()
        .filter_map(|message| message.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let query_embedding = match (api_client.as_ref(), selection) {
        (Some(api_client), Some(selection)) => {
            request_embedding(api_client, &query, &selection.model, "search_query")
                .await
                .ok()
                .flatten()
                .map(|embedding| embedding.values)
        }
        _ => None,
    };
    let now = now_ms() as f64;
    let mut scored = rows
        .into_iter()
        .filter(|memory| !boolean(memory, "archived"))
        .filter(|memory| {
            let sources = memory
                .get("sourceMessageIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            let already_recent = sources.iter().any(|id| recent_ids.contains(id));
            let same_room = string(memory, "sourceRoomId") == room_id
                || string(memory, "roomId") == room_id
                || already_recent;
            !(same_room && already_recent)
        })
        .filter_map(|memory| {
            let content = string(&memory, "content");
            let lexical = lexical_similarity(&query, &content);
            let vector = match (query_embedding.as_ref(), selection, api_client.as_ref()) {
                (Some(query), Some(selection), Some(api_client))
                    if string(&memory, "embeddingModel") == selection.model
                        && string(&memory, "embeddingConnectionId")
                            == api_client.connection_id() =>
                {
                    memory
                        .get("embedding")
                        .and_then(Value::as_array)
                        .map(|values| values.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
                        .map(|stored| cosine_similarity(query, &stored).max(0.0))
                        .unwrap_or(0.0)
                }
                _ => 0.0,
            };
            // 埋め込みが無い、または別のモデル・接続で作られたメモリは字句類似度で判定する。
            if !memory_is_relevant(vector, lexical.max(memory_similarity(&query, &content)))
                && !boolean(&memory, "pinned")
            {
                return None;
            }
            let importance = clamp01(
                memory
                    .get("importance")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.6),
            );
            let confidence = clamp01(
                memory
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.8),
            );
            let usage = clamp01(
                (1.0 + memory
                    .get("usageCount")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0))
                .ln()
                    / 10_f64.ln(),
            );
            let age_days = ((now
                - memory
                    .get("updatedAt")
                    .and_then(Value::as_f64)
                    .unwrap_or(now))
                / 86_400_000.0)
                .max(0.0);
            let recency = if age_days <= 1.0 {
                1.0
            } else if age_days >= 60.0 {
                0.0
            } else {
                1.0 - age_days / 60.0
            };
            let pinned_boost = if boolean(&memory, "pinned") { 2.0 } else { 0.0 };
            let score = pinned_boost
                + if query_embedding.is_some() && vector > 0.0 {
                    vector * 0.62
                        + lexical * 0.14
                        + importance * 0.12
                        + confidence * 0.06
                        + usage * 0.03
                        + recency * 0.03
                } else {
                    lexical * 0.52
                        + importance * 0.22
                        + confidence * 0.12
                        + usage * 0.06
                        + recency * 0.08
                };
            Some(ScoredMemory {
                id: string(&memory, "id"),
                content,
                data: memory,
                score,
            })
        })
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.score.total_cmp(&a.score));
    scored.truncate(MEMORY_LIMIT);
    Ok(scored)
}

struct ExtractionContext {
    character: Value,
    recent_history: Vec<Value>,
    existing_memories: Vec<ScoredMemory>,
}

struct ExtractionGuidance {
    reasons: Vec<MemoryGateReason>,
    used_memory_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShadowGate {
    Extract,
    Skip,
    Failed,
}

impl ShadowGate {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Extract => "extract",
            Self::Skip => "skip",
            Self::Failed => "failed",
        }
    }
}

pub(crate) struct MemoryFollowUp {
    context: ExtractionContext,
    guidance: Option<ExtractionGuidance>,
    shadow: Option<ShadowGate>,
}

#[derive(Default)]
pub(crate) struct MemoryExtraction {
    pub(crate) candidates: Vec<Value>,
    pub(crate) usages: Vec<Value>,
    pub(crate) shadow: Option<ShadowGate>,
}

fn plan_memory_follow_up(
    context: ExtractionContext,
    gate: Option<MemoryGateDecision>,
    shadow_mode: bool,
    gate_enabled: bool,
) -> Option<MemoryFollowUp> {
    if !gate_enabled {
        return Some(MemoryFollowUp {
            context,
            guidance: None,
            shadow: None,
        });
    }
    if shadow_mode {
        let shadow = match &gate {
            Some(decision) if decision.should_extract() => ShadowGate::Extract,
            Some(_) => ShadowGate::Skip,
            None => ShadowGate::Failed,
        };
        return Some(MemoryFollowUp {
            context,
            guidance: None,
            shadow: Some(shadow),
        });
    }
    let decision = gate.filter(MemoryGateDecision::should_extract)?;
    Some(MemoryFollowUp {
        context,
        guidance: Some(ExtractionGuidance {
            reasons: decision.reasons,
            used_memory_ids: decision.used_memory_ids,
        }),
        shadow: None,
    })
}

fn apply_used_memory_ids(messages: &mut [Value], used_memory_ids: &[String]) {
    for message in messages {
        let Some(object) = message.as_object_mut() else {
            continue;
        };
        if used_memory_ids.is_empty() {
            object.remove("usedMemoryIds");
        } else {
            object.insert("usedMemoryIds".into(), json!(used_memory_ids));
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn request_memory_gate(
    clients: &mut RequestClients<'_>,
    payload: &Value,
    context: &ExtractionContext,
    generated: &[Value],
    continuation: bool,
    room: &Value,
    usages: &mut Vec<Value>,
    full_json_logs: &mut Vec<Value>,
) -> Option<MemoryGateDecision> {
    let selection = optional_role_selection(payload, "memoryGateModel", "memoryGateModel");
    let memory_ids = context
        .existing_memories
        .iter()
        .map(|memory| memory.id.clone())
        .collect::<Vec<_>>();
    let memories = context
        .existing_memories
        .iter()
        .map(|memory| memory.content.clone())
        .collect::<Vec<_>>();
    let state = memory_gate_state(&MemoryGateTurn {
        character: &context.character,
        history: &context.recent_history,
        reply: generated,
        memories: &memories,
        continuation,
    });
    let questions = memory_gate_questions(&string(&context.character, "name"), &memories);
    let prompt = crate::user_placeholder::resolve_user_placeholders(
        &serde_json::to_string_pretty(&json!({
            "state": state,
            "questions": questions,
        }))
        .expect("memory gate request must be serializable"),
        clients.user_name(),
    );
    let started = now_ms();
    let debug_context = GenerationDebugContext {
        room,
        character_id: actor_id(&context.character),
        character_name: string(&context.character, "name"),
        model: selection
            .as_ref()
            .map(|selection| selection.model.clone())
            .unwrap_or_default(),
        prompt: &prompt,
    };
    let outcome = match &selection {
        Some(selection) => {
            run_memory_gate(clients, selection, &state, &questions, &memory_ids).await
        }
        None => Err(AppError::BadRequest(
            "memoryGateModel が設定されていません。".into(),
        )),
    };
    match outcome {
        Ok((response, decision)) => {
            push_jev_usage(
                usages,
                &response,
                &usage_character_id(&context.character),
                &debug_context.model,
                "memory-gate",
            );
            let elapsed_ms = now_ms().saturating_sub(started);
            let mut log = json!({
                "roomId": string(room, "id"),
                "roomName": string(room, "name"),
                "characterId": debug_context.character_id,
                "characterName": debug_context.character_name,
                "model": debug_context.model,
                "status": "success",
                "source": "memory-gate-jev",
                "prompt": prompt,
                "json": serde_json::to_string_pretty(&json!({
                    "decision": decision.summary(),
                    "response": response,
                }))
                .expect("Jev response must be serializable"),
                "elapsedMs": elapsed_ms,
            });
            insert_debug_usage(&mut log, "usage", jev_debug_usage(&response, elapsed_ms));
            push_debug_log(full_json_logs, log);
            Some(decision)
        }
        Err(error) => {
            tracing::warn!(
                classification = error.diagnostic_class(),
                "Memory gate failed; this turn is not sent to memory extraction"
            );
            push_error_debug_log(
                full_json_logs,
                &debug_context,
                "memory-gate-error",
                None,
                None,
                &error,
                now_ms().saturating_sub(started),
            );
            None
        }
    }
}

async fn run_memory_gate(
    clients: &mut RequestClients<'_>,
    selection: &RoleSelection,
    state: &Value,
    questions: &Value,
    memory_ids: &[String],
) -> AppResult<(SystemOneResponse, MemoryGateDecision)> {
    let api_client = clients.for_selection(selection)?;
    if !api_client.is_typesafe() && !api_client.is_openrouter() {
        return Err(AppError::BadRequest(
            "メモリ保存の判定にはTypeSafe AIまたはOpenRouter接続が必要です。".into(),
        ));
    }
    let response = system_one(
        &api_client,
        &selection.model,
        state,
        questions,
        MEMORY_GATE_TIMEOUT_SECS,
    )
    .await?;
    let decision = evaluate_memory_gate(&response, memory_ids)?;
    Ok((response, decision))
}

pub(crate) async fn extract_turn_memories(
    state: &AppState,
    payload: &Value,
    follow_up: MemoryFollowUp,
    generated: &[Value],
) -> AppResult<MemoryExtraction> {
    let mut clients = RequestClients::new(state, request_api_config(payload)?);
    let selection =
        resolve_role_selection(payload, "memoryExtractionModel", "memoryExtractionModel")?;
    let room_id = payload
        .pointer("/room/id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut usages = Vec::new();
    let candidates = extract_memory_candidates(
        &mut clients,
        &selection,
        follow_up.context,
        follow_up.guidance.as_ref(),
        generated,
        room_id,
        &mut usages,
    )
    .await?;
    Ok(MemoryExtraction {
        candidates,
        usages,
        shadow: follow_up.shadow,
    })
}

fn memory_prompt_entries<'a>(memories: impl IntoIterator<Item = &'a ScoredMemory>) -> Value {
    memories
        .into_iter()
        .map(|memory| {
            json!({
                "content": memory.content,
                "kind": string(&memory.data, "kind"),
                "scope": string(&memory.data, "scope"),
            })
        })
        .collect()
}

fn memory_extraction_request(
    context: &ExtractionContext,
    guidance: Option<&ExtractionGuidance>,
    generated: &[Value],
) -> (String, Value) {
    let mut recent = context
        .recent_history
        .iter()
        .rev()
        .take(6)
        .cloned()
        .collect::<Vec<_>>();
    recent.reverse();
    recent.extend(generated.iter().cloned());
    for message in &mut recent {
        let text = message_text_with_attachments(message, true);
        if let Some(object) = message.as_object_mut() {
            object.insert("content".into(), Value::String(text));
            object.remove("attachments");
        }
    }
    let mut input = json!({
        "targetCharacter": string(&context.character, "name"),
        "characterSystemPrompt": character_setting(&context.character),
        "recentMessages": recent,
    });
    let Some(guidance) = guidance else {
        input["existingMemories"] = memory_prompt_entries(&context.existing_memories);
        return (memory_extraction_prompt().to_owned(), input);
    };
    let (used, existing): (Vec<_>, Vec<_>) = context
        .existing_memories
        .iter()
        .partition(|memory| guidance.used_memory_ids.contains(&memory.id));
    input["saveReasons"] = guidance
        .reasons
        .iter()
        .map(|reason| Value::String(reason.save_reason().to_owned()))
        .collect();
    input["usedMemories"] = memory_prompt_entries(used);
    input["existingMemories"] = memory_prompt_entries(existing);
    (memory_extraction_guided_prompt().to_owned(), input)
}

#[allow(clippy::too_many_arguments)]
async fn extract_memory_candidates(
    clients: &mut RequestClients<'_>,
    selection: &RoleSelection,
    context: ExtractionContext,
    guidance: Option<&ExtractionGuidance>,
    generated: &[Value],
    room_id: &str,
    usages: &mut Vec<Value>,
) -> AppResult<Vec<Value>> {
    let (system_prompt, input) = memory_extraction_request(&context, guidance, generated);
    let body = json!({
        "model": selection.model,
        "messages": [
            {
                "role": "system",
                "content": system_prompt,
            },
            {
                "role": "user",
                "content": serde_json::to_string(&input)?,
            },
        ],
        "temperature": 0.1,
        "stream": false,
    });
    let api_client = clients.for_selection(selection)?;
    let raw = structured_completion(&api_client, body, memory_schema(), 60).await?;
    push_usage(usages, &raw, &context.character, "memory-extraction");
    let content = extract_message_text(&raw);
    let setting = api_client.resolve_user_placeholders(&character_setting(&context.character));
    let existing_contents = context
        .existing_memories
        .iter()
        .map(|memory| memory.content.as_str())
        .collect::<Vec<_>>();
    let mut accepted_contents: Vec<String> = Vec::new();
    let source_ids = generated
        .iter()
        .filter_map(|message| message.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let now = now_ms();
    let character_id = string(&context.character, "id");
    let mut candidates = parse_memory_updates(&content)
        .into_iter()
        .filter(|update| {
            update
                .get("importance")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                >= MEMORY_MIN_IMPORTANCE
                && update
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    >= MEMORY_MIN_CONFIDENCE
        })
        .filter(|update| {
            let candidate = string(update, "content");
            !candidate.is_empty()
                && memory_similarity(&candidate, &setting) < 0.28
                && !existing_contents
                    .iter()
                    .any(|existing| memory_similarity(&candidate, existing) >= 0.7)
                && !accepted_contents
                    .iter()
                    .any(|existing| memory_similarity(&candidate, existing) >= 0.78)
        })
        .take(MEMORY_MAX_CANDIDATES)
        .collect::<Vec<_>>();
    for (index, candidate) in candidates.iter_mut().enumerate() {
        let content = string(candidate, "content");
        accepted_contents.push(content);
        if let Some(record) = candidate.as_object_mut() {
            record.insert("id".into(), Value::String(format!("memory-{now}-{index}")));
            record.insert("characterId".into(), Value::String(character_id.clone()));
            record.insert("sourceRoomId".into(), Value::String(room_id.into()));
            record.insert("sourceMessageIds".into(), json!(source_ids));
            record.insert("createdAt".into(), json!(now));
            record.insert("updatedAt".into(), json!(now));
            record.insert("usageCount".into(), json!(0));
        }
    }
    Ok(candidates)
}

fn with_speaker_names(
    messages: &[Value],
    participants: &[Value],
    _situation: Option<&Value>,
) -> Vec<Value> {
    let names = participants
        .iter()
        .map(|actor| (actor_id(actor), string(actor, "name")))
        .collect::<HashMap<_, _>>();
    messages
        .iter()
        .map(|message| {
            let mut value = message.clone();
            if string(message, "role") == "assistant" {
                let id = string(message, "characterId");
                let name = if id == NARRATOR_ID && !names.contains_key(&id) {
                    "Narrator".to_owned()
                } else {
                    names.get(&id).cloned().unwrap_or_default()
                };
                value["name"] = Value::String(name);
            }
            value
        })
        .collect()
}

/// 会話中にキャラクターが着用している衣装。costumeSelections の選択を優先し、
/// 未選択・不明な名前のときは default 衣装にフォールバックする。
fn selected_costume<'a>(character: &'a Value, room: &Value) -> Option<&'a Value> {
    let costumes = character.get("costumes").and_then(Value::as_array)?;
    if let Some(costume_name) = room
        .get("costumeSelections")
        .and_then(Value::as_object)
        .and_then(|selections| selections.get(&string(character, "id")))
        .and_then(Value::as_str)
        .filter(|name| !name.eq_ignore_ascii_case("default"))
        && let Some(costume) = costumes
            .iter()
            .find(|costume| string(costume, "name") == costume_name)
    {
        return Some(costume);
    }
    costumes
        .iter()
        .find(|costume| string(costume, "name").eq_ignore_ascii_case("default"))
}

fn expression_names(character: &Value, room: &Value, visual_novel_mode: bool) -> Vec<String> {
    if !visual_novel_mode {
        return Vec::new();
    }
    let selected_costume = room
        .get("costumeSelections")
        .and_then(Value::as_object)
        .and_then(|selections| selections.get(&string(character, "id")))
        .and_then(Value::as_str)
        .filter(|name| *name != "default");
    if let Some(costume_name) = selected_costume
        && let Some(costume) = character
            .get("costumes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|costume| string(costume, "name") == costume_name)
    {
        let mut names = vec!["neutral".into()];
        names.extend(names_from_expressions(costume.get("expressions")));
        return unique_strings(names);
    }
    unique_strings(names_from_expressions(character.get("expressions")))
}

fn motion_names(character: &Value, room: &Value, visual_novel_mode: bool) -> Vec<String> {
    if !visual_novel_mode {
        return Vec::new();
    }
    let selected_costume = room
        .get("costumeSelections")
        .and_then(Value::as_object)
        .and_then(|selections| selections.get(&string(character, "id")))
        .and_then(Value::as_str)
        .filter(|name| *name != "default");
    if let Some(costume_name) = selected_costume
        && let Some(costume) = character
            .get("costumes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|costume| string(costume, "name") == costume_name)
    {
        return unique_strings(names_from_expressions(costume.get("motions")));
    }
    unique_strings(names_from_expressions(character.get("motions")))
}

fn names_from_expressions(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|expression| string(expression, "name"))
        .filter(|name| !name.is_empty())
        .collect()
}

fn usage_character_id(character: &Value) -> String {
    let source_id = string(character, "sourceCharacterId");
    if source_id.is_empty() {
        string(character, "id")
    } else {
        source_id
    }
}

fn push_usage(usages: &mut Vec<Value>, raw: &Value, character: &Value, source: &str) {
    push_usage_with_id(
        usages,
        raw,
        &usage_character_id(character),
        &model_string(character, "model"),
        source,
    );
}

fn push_usage_with_id(
    usages: &mut Vec<Value>,
    raw: &Value,
    character_id: &str,
    model: &str,
    source: &str,
) {
    let Some(usage) = raw.get("usage") else {
        return;
    };
    usages.push(json!({
        "id": format!("usage-{}", now_ms()),
        "characterId": character_id,
        "model": model,
        "source": source,
        "promptTokens": usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
        "completionTokens": usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        "totalTokens": usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
        "cost": usage.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
        "timestamp": now_ms(),
    }));
}

fn object_field<'a>(value: &'a Value, key: &str) -> AppResult<&'a Value> {
    value
        .get(key)
        .filter(|field| field.is_object())
        .ok_or_else(|| AppError::BadRequest(format!("{key} が必要です。")))
}

fn array_field_or(value: &Value, key: &str, fallback: &Value, fallback_key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .or_else(|| fallback.get(fallback_key).and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

fn prepend_situation_prior_messages(
    history: &mut Vec<Value>,
    situation: &Value,
    previous_summary: &str,
) -> usize {
    if !previous_summary.trim().is_empty() {
        return 0;
    }

    let Some(prior_messages) = situation.get("priorMessages").and_then(Value::as_array) else {
        return 0;
    };

    let converted = prior_messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let content = string(message, "content");
            if content.is_empty() {
                return None;
            }
            let id = format!("situation-prior-{index}");
            match string(message, "role").as_str() {
                "user" => Some(json!({
                    "id": id,
                    "role": "user",
                    "content": content,
                })),
                "assistant" => {
                    let character_id = string(message, "actorId");
                    (!character_id.is_empty()).then(|| {
                        json!({
                            "id": id,
                            "role": "assistant",
                            "content": content,
                            "characterId": character_id,
                        })
                    })
                }
                _ => None,
            }
        })
        .collect::<Vec<_>>();

    if converted.is_empty() {
        return 0;
    }

    let prior_message_count = converted.len();
    let mut merged = converted;
    merged.append(history);
    *history = merged;
    prior_message_count
}

fn count_user_messages(messages: &[Value]) -> usize {
    messages
        .iter()
        .filter(|message| string(message, "role") == "user")
        .count()
}

fn cut_before_last_user_messages(messages: &[Value], keep: usize) -> usize {
    if keep == 0 {
        return messages.len();
    }
    let mut seen = 0;
    for index in (0..messages.len()).rev() {
        if string(&messages[index], "role") == "user" {
            seen += 1;
            if seen == keep {
                return index;
            }
        }
    }
    0
}

fn slice_by_user_history(messages: &[Value], limit: usize) -> Vec<Value> {
    let cut = cut_before_last_user_messages(messages, limit);
    messages[cut..].to_vec()
}

// The presenter folds this first reply into the previous assistant message
// when the same character keeps speaking, so the boundary is persisted.
fn mark_continuation_start(messages: &mut [Value], enabled: bool) {
    if !enabled {
        return;
    }
    if let Some(object) = messages.first_mut().and_then(Value::as_object_mut) {
        object.insert("continuesPrevious".to_owned(), Value::Bool(true));
    }
}

fn with_continuation_trigger(mut messages: Vec<Value>, enabled: bool) -> Vec<Value> {
    if enabled {
        messages.push(json!({
            "role": "user",
            "content": CONTINATUION_TRIGGER,
            "internal": true,
        }));
    }
    messages
}

fn summary_cut(messages: &[Value], prior_message_count: usize) -> usize {
    cut_before_last_user_messages(messages, SUMMARY_RECENT_USER_TURNS_TO_KEEP)
        .max(prior_message_count.min(messages.len()))
}

fn summary_checkpoint_user_message_id(
    history: &[Value],
    summarized_count: usize,
    prior_message_count: usize,
) -> Option<String> {
    let summarized_end = summarized_count.min(history.len());
    let persisted_start = prior_message_count.min(summarized_end);
    history[persisted_start..summarized_end]
        .iter()
        .rev()
        .find(|message| string(message, "role") == "user")
        .map(|message| string(message, "id"))
        .filter(|message_id| !message_id.is_empty())
}

fn history_content(message: &Value) -> String {
    let base = insert_space_after_italic_action(
        &sanitize_message_content(&string(message, "content")).replace(['\r', '\n'], ""),
    );
    let mut sections = Vec::new();
    if !base.is_empty() {
        sections.push(base);
    }
    if let Some(attachments) = message.get("attachments").and_then(Value::as_array) {
        for attachment in attachments {
            let kind = string(attachment, "kind");
            let name = string(attachment, "name");
            let data = attachment
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if kind == "file" {
                let label = if name.is_empty() {
                    "ファイル"
                } else {
                    &name
                };
                if data.is_empty() {
                    sections.push(format!("[添付ファイル: {label}]"));
                } else {
                    sections.push(format!("[添付ファイル: {label}]\n{data}"));
                }
            } else if kind == "image" && data.is_empty() {
                // data を持つ画像は image_url パーツで送られるため、data が
                // 削られた画像だけ名前のマーカーを残す。
                let label = if name.is_empty() { "画像" } else { &name };
                sections.push(format!("[添付画像: {label}]"));
            }
        }
    }
    sections.join("\n\n")
}

fn history_message_content(message: &Value) -> Value {
    let text = history_content(message);
    let images = message_image_attachment_urls(message);
    if images.is_empty() {
        return Value::String(text);
    }
    let mut parts = Vec::with_capacity(images.len() + usize::from(!text.is_empty()));
    if !text.is_empty() {
        parts.push(json!({
            "type": "text",
            "text": text,
        }));
    }
    for url in images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": url },
        }));
    }
    Value::Array(parts)
}

fn insert_space_after_italic_action(content: &str) -> String {
    let bytes = content.as_bytes();
    let mut result = String::with_capacity(content.len());
    let mut copied_until = 0;
    let mut index = 0;

    while index < bytes.len() {
        if !is_single_asterisk_marker(bytes, index) {
            index += 1;
            continue;
        }

        let opening = index;
        let mut closing = opening + 1;
        while closing < bytes.len() && !is_single_asterisk_marker(bytes, closing) {
            closing += 1;
        }
        if closing >= bytes.len() || closing == opening + 1 {
            index = opening + 1;
            continue;
        }

        let after_closing = closing + 1;
        if after_closing < bytes.len()
            && !bytes[after_closing].is_ascii_whitespace()
            && bytes[after_closing] != b'*'
        {
            result.push_str(&content[copied_until..after_closing]);
            result.push(' ');
            copied_until = after_closing;
        }
        index = after_closing;
    }

    result.push_str(&content[copied_until..]);
    result
}

fn is_single_asterisk_marker(bytes: &[u8], index: usize) -> bool {
    if bytes.get(index) != Some(&b'*')
        || bytes.get(index.wrapping_sub(1)) == Some(&b'*')
        || bytes.get(index + 1) == Some(&b'*')
    {
        return false;
    }

    let preceding_backslashes = bytes[..index]
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\\')
        .count();
    preceding_backslashes % 2 == 0
}

fn sanitize_assistant_history(messages: &mut [Value]) {
    for message in messages {
        if string(message, "role") != "assistant" {
            continue;
        }
        let content = string(message, "content");
        if let Some(object) = message.as_object_mut() {
            object.insert(
                "content".to_owned(),
                Value::String(sanitize_assistant_reply_content(&content)),
            );
        }
    }
}

fn number_u64(value: &Value, key: &str, fallback: u64) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(fallback)
}

fn number_f64(value: &Value, key: &str, fallback: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let dot = a
        .iter()
        .zip(b)
        .map(|(left, right)| left * right)
        .sum::<f64>();
    let norm_a = a.iter().map(|value| value * value).sum::<f64>().sqrt();
    let norm_b = b.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot / (norm_a * norm_b)
    }
}

fn normalized_memory_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !"「」『』（）()[]{}.,，。!！?？:：;；、・".contains(*character)
        })
        .collect()
}

fn signals(value: &str) -> HashSet<String> {
    let compact = normalized_memory_key(value);
    let chars = compact.chars().collect::<Vec<_>>();
    chars
        .windows(2)
        .map(|window| window.iter().collect::<String>())
        .collect()
}

fn memory_similarity(left: &str, right: &str) -> f64 {
    let left_key = normalized_memory_key(left);
    let right_key = normalized_memory_key(right);
    if left_key.is_empty() || right_key.is_empty() {
        return 0.0;
    }
    if left_key == right_key {
        return 1.0;
    }
    if left_key.contains(&right_key) || right_key.contains(&left_key) {
        return left_key.chars().count().min(right_key.chars().count()) as f64
            / left_key.chars().count().max(right_key.chars().count()) as f64;
    }
    let left_signals = signals(left);
    let right_signals = signals(right);
    if left_signals.is_empty() || right_signals.is_empty() {
        return 0.0;
    }
    left_signals.intersection(&right_signals).count() as f64
        / left_signals.len().min(right_signals.len()) as f64
}

fn lexical_similarity(query: &str, content: &str) -> f64 {
    let query_signals = signals(query);
    if query_signals.is_empty() {
        return 0.0;
    }
    let content_signals = signals(content);
    query_signals.intersection(&content_signals).count() as f64 / query_signals.len().min(12) as f64
}

/// そのメモリを今回のコンテキストへ注入するかどうかを、関連度だけで決める。
/// 埋め込み類似度か字句類似度のどちらかが下限を超えていれば採用する。
fn memory_is_relevant(vector: f64, lexical: f64) -> bool {
    vector >= MEMORY_MIN_VECTOR_SIMILARITY || lexical >= MEMORY_MIN_LEXICAL_SIMILARITY
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.to_lowercase()))
        .collect()
}

fn extend_unique<I>(values: &mut Vec<String>, additions: I)
where
    I: IntoIterator<Item = String>,
{
    let mut seen = values.iter().cloned().collect::<HashSet<_>>();
    values.extend(
        additions
            .into_iter()
            .filter(|value| seen.insert(value.clone())),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_completion_preserves_explicit_penalties_and_omits_unset_values() {
        let sampling = json!({
            "frequencyPenalty": 0,
            "presencePenalty": -0.5,
            "repetitionPenalty": 1.15,
        });
        let body = chat_completion_body("test-model", Vec::new(), &sampling, None, 2048);
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["frequency_penalty"], 0);
        assert_eq!(body["presence_penalty"], -0.5);
        assert_eq!(body["repetition_penalty"], 1.15);

        for sampling in [
            Value::Null,
            json!({
                "frequencyPenalty": null,
                "presencePenalty": null,
                "repetitionPenalty": null,
            }),
        ] {
            let body = chat_completion_body("test-model", Vec::new(), &sampling, None, 2048);
            for key in [
                "frequency_penalty",
                "presence_penalty",
                "repetition_penalty",
            ] {
                assert!(body.get(key).is_none(), "unset {key} must be omitted");
            }
            assert_eq!(body["temperature"], DEFAULT_TEMPERATURE);
            assert_eq!(body["top_p"], DEFAULT_TOP_P);
        }
    }

    #[test]
    fn chat_completion_uses_global_sampling_and_reasoning_effort() {
        let payload = json!({"chatSampling": {"temperature": 0.3, "topP": 0.9, "topK": 40}});
        let body = chat_completion_body(
            "test-model",
            Vec::new(),
            chat_sampling(&payload),
            Some("low"),
            4096,
        );
        assert_eq!(body["temperature"], 0.3);
        assert_eq!(body["top_p"], 0.9);
        assert_eq!(body["top_k"], 40);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["reasoningEffort"], "low");

        let without_effort = chat_completion_body(
            "test-model",
            Vec::new(),
            chat_sampling(&json!({})),
            None,
            2048,
        );
        assert!(without_effort.get("reasoningEffort").is_none());
    }

    #[test]
    fn chat_model_comes_from_the_global_default() {
        let payload = json!({
            "aiApiConfig": {
                "modelDefaults": {
                    "defaultChatModel": {"model": "chat-model", "connectionId": "cx_1"}
                }
            },
            "character": {"model": "ignored-character-model"},
        });
        let selection = chat_model_selection(&payload).expect("chat model");
        assert_eq!(selection.model, "chat-model");
        assert_eq!(selection.connection_id.as_deref(), Some("cx_1"));
    }

    #[test]
    fn addressed_participant_is_the_first_name_in_the_latest_user_message() {
        let participants = vec![
            json!({"actorId": "a", "name": "葵"}),
            json!({"actorId": "b", "name": "凛"}),
        ];
        let history = vec![json!({"role": "user", "content": "ねえ凛、葵はどう思う？"})];
        let addressed = addressed_participant(&history, &participants).expect("addressed");
        assert_eq!(actor_id(addressed), "b");

        let nobody = vec![json!({"role": "user", "content": "みんな元気？"})];
        assert!(addressed_participant(&nobody, &participants).is_none());

        let after_reply = vec![
            json!({"role": "user", "content": "凛、おはよう"}),
            json!({"role": "assistant", "characterId": "b", "content": "おはよう"}),
        ];
        assert!(addressed_participant(&after_reply, &participants).is_none());
    }

    #[test]
    fn ensemble_history_groups_consecutive_character_turns() {
        let history = vec![
            json!({"role": "user", "content": "おはよう"}),
            json!({"role": "assistant", "characterId": "a", "content": "*手を振る* おはよう！"}),
            json!({"role": "assistant", "characterId": "a", "content": "今日も早いね"}),
            json!({"role": "assistant", "characterId": "b", "content": "おはよ"}),
            json!({"role": "user", "content": "眠い"}),
        ];
        let messages = ensemble_request_history(&history, false);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
        let turns: Value =
            serde_json::from_str(messages[1]["content"].as_str().expect("turns json"))
                .expect("valid json");
        assert_eq!(
            turns,
            json!({"turns": [
                {"speaker": "a", "message": "*手を振る* おはよう！\n\n今日も早いね"},
                {"speaker": "b", "message": "おはよ"},
            ]})
        );
        assert_eq!(messages[2]["content"], "眠い");

        let message_mode = ensemble_request_history(&history, true);
        let turns: Value =
            serde_json::from_str(message_mode[1]["content"].as_str().expect("turns json"))
                .expect("valid json");
        assert_eq!(
            turns["turns"][0],
            json!({"speaker": "a", "messages": ["*手を振る* おはよう！", "今日も早いね"]})
        );
        // speaker が先頭に来ると、出力スキーマと同じ並びのお手本になる。
        assert!(
            message_mode[1]["content"]
                .as_str()
                .expect("turns json")
                .starts_with(r#"{"turns":[{"speaker":"a""#)
        );
    }

    #[test]
    fn ensemble_budget_grows_with_turns_and_is_capped() {
        assert_eq!(ensemble_max_tokens(1, false), CHAT_COMPLETION_MAX_TOKENS);
        assert_eq!(ensemble_max_tokens(3, false), CHAT_COMPLETION_MAX_TOKENS + 2048);
        assert_eq!(ensemble_max_tokens(3, true), CHAT_COMPLETION_MAX_TOKENS + 2560);
        assert_eq!(ensemble_max_tokens(10, true), 8192);
        assert_eq!(ensemble_timeout_secs(1), 120);
        assert_eq!(ensemble_timeout_secs(10), 300);
    }

    #[test]
    fn character_reply_length_defaults_to_512_characters() {
        assert_eq!(character_max_characters(&json!({})), 512);
        assert_eq!(
            character_max_characters(&json!({"maxCharacters": 256})),
            256
        );
        assert_eq!(character_max_characters(&json!({"maxCharacters": 0})), 1);
    }

    #[test]
    fn generation_errors_create_displayable_debug_entries() {
        let room = json!({"id": "room-1", "name": "Room 1"});
        let context = GenerationDebugContext {
            room: &room,
            character_id: "character-1".to_owned(),
            character_name: "葵".to_owned(),
            model: "test-model".to_owned(),
            prompt: "[]",
        };
        let error = AppError::Upstream(
            "upstream rejected the request".to_owned(),
            axum::http::StatusCode::TOO_MANY_REQUESTS,
        );
        let mut logs = Vec::new();

        push_error_debug_log(
            &mut logs,
            &context,
            chat_error_source(&error),
            None,
            None,
            &error,
            123,
        );

        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0]["status"], "error");
        assert_eq!(logs[0]["source"], "chat-http-error");
        assert_eq!(logs[0]["httpStatus"], 429);
        assert_eq!(logs[0]["elapsedMs"], 123);
        assert_eq!(logs[0]["errorName"], "upstream_rate_limit");
        assert!(
            logs[0]["json"]
                .as_str()
                .is_some_and(|value| value.contains("upstream rejected"))
        );
    }

    #[test]
    fn malformed_completion_errors_use_the_response_parse_source() {
        let error = AppError::Upstream(
            "ストリーミング応答のJSONを解析できませんでした".to_owned(),
            axum::http::StatusCode::BAD_GATEWAY,
        );

        assert_eq!(chat_error_source(&error), "chat-response-parse-error");
    }

    #[test]
    fn successful_debug_logs_carry_tokens_cost_and_throughput() {
        let usage = token_debug_usage(DebugUsageInput {
            prompt_tokens: 1200,
            completion_tokens: 400,
            total_tokens: Some(1600),
            cost: Some(0.0042),
            elapsed_ms: 8000,
            ..Default::default()
        })
        .expect("reporting tokens must produce debug usage fields");

        assert_eq!(usage["promptTokens"], 1200);
        assert_eq!(usage["completionTokens"], 400);
        assert_eq!(usage["totalTokens"], 1600);
        assert_eq!(usage["cost"], 0.0042);
        assert_eq!(usage["tokensPerSecond"], 50.0);

        let mut log = json!({"status": "success"});
        insert_debug_usage(&mut log, "usage", Some(usage));

        assert_eq!(log["usage"]["totalTokens"], 1600);
        assert_eq!(log["status"], "success");
    }

    #[test]
    fn debug_usage_fields_are_omitted_when_the_provider_reports_nothing() {
        assert!(
            token_debug_usage(DebugUsageInput {
                elapsed_ms: 1000,
                ..Default::default()
            })
            .is_none()
        );
        assert!(completion_debug_usage(&json!({"model": "test-model"}), 1000).is_none());

        // total_tokens を返さない応答は入力と出力から合計を作る。
        let usage = completion_debug_usage(
            &json!({"usage": {"prompt_tokens": 10, "completion_tokens": 5}}),
            500,
        )
        .expect("usage fields");

        assert_eq!(usage["totalTokens"], 15);
        assert_eq!(usage["tokensPerSecond"], 10.0);
        assert!(usage.get("cost").is_none());
    }

    #[test]
    fn streaming_timings_measure_decode_speed_apart_from_prompt_processing() {
        let raw = json!({
            "choices": [{ "message": { "content": "{\"message\":\"こんにちは\"}" } }],
            "usage": { "prompt_tokens": 2000, "completion_tokens": 100, "total_tokens": 2100 },
            "kataruTimings": { "firstTokenMs": 2000, "decodeMs": 4000 }
        });

        let usage = completion_debug_usage(&raw, 6000).expect("usage fields");

        // プロンプト処理を除いたデコード区間だけで測るので 100 / 4秒 = 25 tok/s。
        assert_eq!(usage["tokensPerSecond"], 25.0);
        assert_eq!(usage["timeToFirstTokenMs"], 2000);
        // 2000 プロンプトトークンを 2 秒で処理した計算。
        assert_eq!(usage["promptTokensPerSecond"], 1000.0);
    }

    #[test]
    fn llama_cpp_timings_are_preferred_over_elapsed_time() {
        let raw = json!({
            "choices": [{ "message": { "content": "{\"message\":\"hi\"}" } }],
            "timings": {
                "prompt_n": 900,
                "prompt_per_second": 450.5,
                "predicted_n": 40,
                "predicted_per_second": 21.7
            }
        });

        let usage = completion_debug_usage(&raw, 9000).expect("usage fields");

        assert_eq!(usage["promptTokens"], 900);
        assert_eq!(usage["completionTokens"], 40);
        assert_eq!(usage["tokensPerSecond"], 21.7);
        assert_eq!(usage["promptTokensPerSecond"], 450.5);
        assert!(usage.get("estimated").is_none());
    }

    #[test]
    fn missing_local_usage_is_estimated_from_the_output_text() {
        let raw = json!({
            "choices": [{ "message": { "content": "こんにちは、世界！" } }],
            "kataruTimings": { "firstTokenMs": 500, "decodeMs": 1000 }
        });

        let usage = completion_debug_usage(&raw, 1500).expect("estimated usage");

        // 日本語は1文字1トークンとして概算する。
        assert_eq!(usage["completionTokens"], 9);
        assert_eq!(usage["totalTokens"], 9);
        assert_eq!(usage["estimated"], true);
        assert_eq!(usage["tokensPerSecond"], 9.0);
    }

    #[test]
    fn jev_debug_usage_maps_input_and_output_tokens() {
        let response = SystemOneResponse {
            model: "jev-latest".to_owned(),
            answers: HashMap::new(),
            usage: Some(crate::ai::typesafe::JevUsage {
                input_tokens: 300,
                output_tokens: 20,
            }),
        };

        let usage = jev_debug_usage(&response, 2000).expect("Jev usage fields");

        assert_eq!(usage["promptTokens"], 300);
        assert_eq!(usage["completionTokens"], 20);
        assert_eq!(usage["totalTokens"], 320);
        assert_eq!(usage["tokensPerSecond"], 10.0);

        let without_usage = SystemOneResponse {
            usage: None,
            ..response
        };
        assert!(jev_debug_usage(&without_usage, 2000).is_none());
    }

    #[test]
    fn generated_messages_record_the_memories_inserted_into_the_prompt() {
        let messages = envelope_to_messages(
            AssistantEnvelope {
                message: "reply".to_owned(),
                messages: Vec::new(),
                to: Vec::new(),
                expression: None,
                motion: None,
            },
            &json!({"id": "character-1", "name": "葵"}),
            false,
            0,
            &["memory-1".to_owned(), "memory-2".to_owned()],
        );

        assert_eq!(
            messages[0]["usedMemoryIds"],
            json!(["memory-1", "memory-2"])
        );
    }

    fn scored_memory(id: &str, content: &str) -> ScoredMemory {
        ScoredMemory {
            id: id.to_owned(),
            content: content.to_owned(),
            data: json!({
                "id": id,
                "content": content,
                "kind": "fact",
                "scope": "character",
                "embedding": [0.1, 0.2, 0.3],
            }),
            score: 1.0,
        }
    }

    fn extraction_context() -> ExtractionContext {
        ExtractionContext {
            character: json!({"id": "character-1", "name": "葵", "systemPrompt": "高校生"}),
            recent_history: vec![json!({"role": "user", "content": "猫が苦手なんだ"})],
            existing_memories: vec![
                scored_memory("memory-used", "{{user}}は紅茶が好き"),
                scored_memory("memory-other", "葵は弓道部"),
            ],
        }
    }

    fn gate_decision(new_reasons: &[&str], used: &[&str]) -> MemoryGateDecision {
        let mut answers = serde_json::Map::new();
        for reason in [
            "world",
            "character",
            "relationship",
            "protagonist",
            "instruction",
        ] {
            let probability = if new_reasons.contains(&reason) {
                0.8
            } else {
                0.1
            };
            answers.insert(
                format!("reason_{reason}"),
                json!({
                    "type": "choice",
                    "choice": if probability > 0.5 { "new" } else { "none" },
                    "probabilities": {"none": 1.0 - probability, "known": 0.0, "new": probability},
                }),
            );
        }
        let memory_ids = ["memory-used", "memory-other"];
        for (index, id) in memory_ids.iter().enumerate() {
            answers.insert(
                format!("used_{index}"),
                json!({"type": "noul", "noul": if used.contains(id) { 0.9 } else { 0.1 }}),
            );
        }
        let response: SystemOneResponse = serde_json::from_value(json!({
            "model": "jev-latest",
            "answers": answers,
        }))
        .expect("gate response");
        evaluate_memory_gate(&response, &memory_ids.map(str::to_owned)).expect("gate decision")
    }

    #[test]
    fn memory_gate_skips_extraction_without_new_information() {
        let follow_up = plan_memory_follow_up(
            extraction_context(),
            Some(gate_decision(&[], &[])),
            false,
            true,
        );
        assert!(follow_up.is_none());
    }

    #[test]
    fn failed_memory_gate_does_not_request_extraction() {
        assert!(plan_memory_follow_up(extraction_context(), None, false, true).is_none());
    }

    #[test]
    fn memory_gate_passes_reasons_and_used_memories_to_extraction() {
        let follow_up = plan_memory_follow_up(
            extraction_context(),
            Some(gate_decision(&["protagonist"], &["memory-used"])),
            false,
            true,
        )
        .expect("follow-up");
        assert!(follow_up.shadow.is_none());

        let (system_prompt, input) = memory_extraction_request(
            &follow_up.context,
            follow_up.guidance.as_ref(),
            &[json!({"role": "assistant", "content": "覚えておくね"})],
        );

        assert!(system_prompt.contains("saveReasons"));
        assert_eq!(
            input["saveReasons"],
            json!([MemoryGateReason::Protagonist.save_reason()])
        );
        assert_eq!(
            input["usedMemories"],
            json!([{"content": "{{user}}は紅茶が好き", "kind": "fact", "scope": "character"}])
        );
        assert_eq!(
            input["existingMemories"],
            json!([{"content": "葵は弓道部", "kind": "fact", "scope": "character"}])
        );
        assert_eq!(input["recentMessages"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn shadow_mode_always_extracts_with_the_unguided_prompt() {
        for (gate, expected) in [
            (Some(gate_decision(&[], &[])), ShadowGate::Skip),
            (Some(gate_decision(&["world"], &[])), ShadowGate::Extract),
            (None, ShadowGate::Failed),
        ] {
            let follow_up =
                plan_memory_follow_up(extraction_context(), gate, true, true).expect("follow-up");
            assert_eq!(follow_up.shadow, Some(expected));
            assert!(follow_up.guidance.is_none());

            let (system_prompt, input) = memory_extraction_request(&follow_up.context, None, &[]);
            assert_eq!(system_prompt, memory_extraction_prompt());
            assert!(input.get("saveReasons").is_none());
            assert!(input.get("usedMemories").is_none());
            assert_eq!(input["existingMemories"].as_array().map(Vec::len), Some(2));
            assert!(input["existingMemories"][0].get("embedding").is_none());
        }
    }

    #[test]
    fn disabled_gate_always_extracts_with_the_unguided_prompt() {
        for shadow_mode in [false, true] {
            let follow_up = plan_memory_follow_up(extraction_context(), None, shadow_mode, false)
                .expect("follow-up");
            assert!(follow_up.shadow.is_none());
            assert!(follow_up.guidance.is_none());

            let (system_prompt, input) = memory_extraction_request(&follow_up.context, None, &[]);
            assert_eq!(system_prompt, memory_extraction_prompt());
            assert!(input.get("saveReasons").is_none());
            assert!(input.get("usedMemories").is_none());
            assert_eq!(input["existingMemories"].as_array().map(Vec::len), Some(2));
        }
    }

    #[test]
    fn gate_used_memories_replace_the_prompt_memories_on_messages() {
        let mut messages = vec![
            json!({"id": "message-1", "usedMemoryIds": ["memory-used", "memory-other"]}),
            json!({"id": "message-2", "usedMemoryIds": ["memory-used", "memory-other"]}),
        ];

        apply_used_memory_ids(&mut messages, &["memory-used".to_owned()]);
        assert_eq!(messages[0]["usedMemoryIds"], json!(["memory-used"]));
        assert_eq!(messages[1]["usedMemoryIds"], json!(["memory-used"]));

        apply_used_memory_ids(&mut messages, &[]);
        assert!(messages[0].get("usedMemoryIds").is_none());
    }

    #[test]
    fn history_slice_keeps_complete_user_turns() {
        let messages = vec![
            json!({"role":"user","content":"1"}),
            json!({"role":"assistant","content":"a"}),
            json!({"role":"user","content":"2"}),
            json!({"role":"assistant","content":"b"}),
        ];
        assert_eq!(slice_by_user_history(&messages, 1).len(), 2);
        assert_eq!(cut_before_last_user_messages(&messages, 1), 2);
    }

    #[test]
    fn continuation_trigger_is_transient_and_ends_generation_history_with_user() {
        let history = vec![
            json!({"role":"user","content":"今日は寒いね"}),
            json!({"role":"assistant","content":"雪になるかも"}),
        ];

        let request_history = with_continuation_trigger(history.clone(), true);

        assert_eq!(history.len(), 2);
        assert_eq!(request_history.len(), 3);
        assert_eq!(request_history[2]["role"], "user");
        assert_eq!(request_history[2]["internal"], true);
        assert!(
            request_history[2]["content"]
                .as_str()
                .is_some_and(|content| content.contains("{{user}}から新しい発言や行動はありません"))
        );
    }

    #[test]
    fn regular_generation_history_does_not_receive_a_continuation_trigger() {
        let history = vec![json!({"role":"user","content":"こんにちは"})];

        assert_eq!(with_continuation_trigger(history.clone(), false), history);
    }

    #[test]
    fn continuation_marks_only_the_first_generated_message() {
        let mut generated = vec![
            json!({"role": "assistant", "content": "続き1"}),
            json!({"role": "assistant", "content": "続き2"}),
        ];

        mark_continuation_start(&mut generated, true);

        assert_eq!(generated[0]["continuesPrevious"], true);
        assert!(generated[1].get("continuesPrevious").is_none());
    }

    #[test]
    fn reply_generation_does_not_mark_continuation() {
        let mut generated = vec![json!({"role": "assistant", "content": "返答"})];

        mark_continuation_start(&mut generated, false);

        assert!(generated[0].get("continuesPrevious").is_none());
    }

    #[test]
    fn history_content_removes_newlines() {
        let message = json!({"content": "一行目\n二行目\r\n三行目\\n*未完了"});

        assert_eq!(history_content(&message), "一行目二行目三行目未完了");
    }

    #[test]
    fn history_content_separates_italic_action_from_following_message() {
        let message = json!({"content": "*動作*こんにちは。*視線を上げる*元気？"});

        assert_eq!(
            history_content(&message),
            "*動作* こんにちは。*視線を上げる* 元気？"
        );
    }

    #[test]
    fn history_content_keeps_existing_spaces_and_literal_asterisks() {
        let message = json!({"content": "*動作* こんにちは。\\*literal\\*text"});

        assert_eq!(
            history_content(&message),
            "*動作* こんにちは。\\*literal\\*text"
        );
    }

    #[test]
    fn sanitizes_only_assistant_history_before_upstream_requests() {
        let mut messages = vec![
            json!({"role":"user","content":"user *literal"}),
            json!({"role":"assistant","content":"assistant\\n*unfinished"}),
        ];

        sanitize_assistant_history(&mut messages);

        assert_eq!(messages[0]["content"], "user *literal");
        assert_eq!(messages[1]["content"], "assistantunfinished");
    }

    #[test]
    fn situation_prior_messages_are_prepended_to_history() {
        let situation = json!({
            "priorMessages": [
                {"id": "prior-user", "role": "user", "content": "以前の発言"},
                {"id": "prior-assistant", "role": "assistant", "content": "以前の返答", "actorId": "actor-1"}
            ]
        });
        let mut history = vec![json!({"id": "current", "role": "user", "content": "現在の発言"})];

        prepend_situation_prior_messages(&mut history, &situation, "");

        assert_eq!(history.len(), 3);
        assert_eq!(history[0]["role"], "user");
        assert_eq!(history[0]["content"], "以前の発言");
        assert_eq!(history[1]["role"], "assistant");
        assert_eq!(history[1]["characterId"], "actor-1");
        assert_eq!(history[2]["id"], "current");
    }

    #[test]
    fn situation_prior_messages_are_not_reintroduced_after_summary() {
        let situation = json!({
            "priorMessages": [
                {"id": "prior-user", "role": "user", "content": "以前の発言"},
                {"id": "prior-assistant", "role": "assistant", "content": "以前の返答", "actorId": "actor-1"}
            ]
        });
        let mut history = vec![json!({"id": "current", "role": "user", "content": "現在の発言"})];

        prepend_situation_prior_messages(&mut history, &situation, "これまでの要約");

        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["id"], "current");
    }

    #[test]
    fn situation_prior_messages_age_out_of_the_active_history() {
        let situation = json!({
            "priorMessages": [
                {"id": "prior-user", "role": "user", "content": "以前の発言"},
                {"id": "prior-assistant", "role": "assistant", "content": "以前の返答", "actorId": "actor-1"}
            ]
        });
        let mut history = vec![
            json!({"id": "current-user-1", "role": "user", "content": "現在の発言1"}),
            json!({"id": "current-assistant-1", "role": "assistant", "content": "現在の返答1", "characterId": "actor-1"}),
            json!({"id": "current-user-2", "role": "user", "content": "現在の発言2"}),
        ];

        prepend_situation_prior_messages(&mut history, &situation, "");
        let active = slice_by_user_history(&history, 2);

        assert_eq!(active.len(), 3);
        assert_eq!(active[0]["id"], "current-user-1");
        assert_eq!(active[2]["id"], "current-user-2");
    }

    #[test]
    fn situation_prior_messages_remain_in_the_initial_summary_slice() {
        let situation = json!({
            "priorMessages": [
                {"id": "prior-user-1", "role": "user", "content": "以前の発言1"},
                {"id": "prior-assistant-1", "role": "assistant", "content": "以前の返答1", "actorId": "actor-1"},
                {"id": "prior-user-2", "role": "user", "content": "以前の発言2"},
                {"id": "prior-assistant-2", "role": "assistant", "content": "以前の返答2", "actorId": "actor-1"}
            ]
        });
        let mut history = vec![
            json!({"id": "current-user-1", "role": "user", "content": "現在の発言1"}),
            json!({"id": "current-assistant-1", "role": "assistant", "content": "現在の返答1", "characterId": "actor-1"}),
            json!({"id": "current-user-2", "role": "user", "content": "現在の発言2"}),
        ];

        let prior_message_count = prepend_situation_prior_messages(&mut history, &situation, "");
        let cut = summary_cut(&history, prior_message_count);

        assert_eq!(cut, 4);
        assert_eq!(history[0]["content"], "以前の発言1");
        assert_eq!(history[3]["content"], "以前の返答2");
        assert_eq!(history[cut]["id"], "current-user-1");
    }

    #[test]
    fn summary_checkpoint_is_the_last_persisted_user_in_the_summarized_slice() {
        let history = vec![
            json!({"id": "prior-user", "role": "user"}),
            json!({"id": "prior-assistant", "role": "assistant"}),
            json!({"id": "archived-user", "role": "user"}),
            json!({"id": "archived-assistant", "role": "assistant"}),
            json!({"id": "kept-user", "role": "user"}),
            json!({"id": "kept-assistant", "role": "assistant"}),
        ];

        assert_eq!(
            summary_checkpoint_user_message_id(&history, 4, 2).as_deref(),
            Some("archived-user")
        );
        assert_eq!(summary_checkpoint_user_message_id(&history, 2, 2), None);
    }

    #[test]
    fn similar_memory_text_scores_high() {
        assert!(memory_similarity("{{user}}はコーヒーが好き", "{{user}}はコーヒーが好き。") > 0.9);
    }

    #[test]
    fn memories_without_any_relevance_are_not_injected() {
        let query = "今日は学校で何があったの？";
        // 重要度や固定に関係なく、関連度がゼロのメモリは注入しない。
        for content in ["{{user}}は紅茶が好き", "葵は弓道部", "宇宙船を修理した"]
        {
            let lexical = lexical_similarity(query, content).max(memory_similarity(query, content));
            assert!(!memory_is_relevant(0.0, lexical), "{content}");
        }
        // 埋め込みも下限未満なら採用しない。
        assert!(!memory_is_relevant(
            MEMORY_MIN_VECTOR_SIMILARITY - 0.01,
            0.0
        ));
    }

    #[test]
    fn memories_related_to_the_query_are_injected() {
        let query = "今日は学校で何があったの？";
        let related = "学校であった出来事を覚えている";
        let lexical = lexical_similarity(query, related).max(memory_similarity(query, related));
        assert!(memory_is_relevant(0.0, lexical));
        // 語が重ならなくても、埋め込みが下限以上なら採用する。
        assert!(memory_is_relevant(MEMORY_MIN_VECTOR_SIMILARITY, 0.0));
    }

    #[test]
    fn single_participant_situation_is_limited_to_one_turn() {
        let room = json!({"maxMentionChain": 8});
        let situation = json!({"maxTurns": 6});

        assert_eq!(situation_max_turns(&room, &situation, 1), Some(1));
    }

    #[test]
    fn multi_participant_situation_uses_configured_turn_limit() {
        let situation = json!({"maxTurns": 6, "limitTurns": true});

        assert_eq!(situation_max_turns(&json!({}), &situation, 2), Some(6));
        assert_eq!(
            situation_max_turns(&json!({"maxMentionChain": 4}), &situation, 2),
            Some(4)
        );
    }

    #[test]
    fn situation_turn_limit_is_off_by_default() {
        let room = json!({"maxMentionChain": 4});

        assert_eq!(situation_max_turns(&room, &json!({"maxTurns": 6}), 2), None);
        assert_eq!(
            situation_max_turns(&room, &json!({"maxTurns": 6, "limitTurns": false}), 2),
            None
        );
    }

    #[test]
    fn visual_novel_uses_selected_costume_expressions() {
        let character = json!({
            "id": "actor-1",
            "expressions": [
                {"name": "neutral"},
                {"name": "happy"}
            ],
            "costumes": [{
                "name": "uniform",
                "expressions": [{"name": "uniform-happy"}]
            }]
        });
        let room = json!({
            "viewMode": "vn",
            "costumeSelections": {"actor-1": "uniform"}
        });

        assert_eq!(
            expression_names(&character, &room, true),
            vec!["neutral", "uniform-happy"]
        );
        assert!(expression_names(&character, &room, false).is_empty());
    }

    #[test]
    fn visual_novel_uses_selected_costume_motions() {
        let character = json!({
            "id": "actor-1",
            "motions": [
                {"name": "wave"},
                {"name": "jump"}
            ],
            "costumes": [{
                "name": "uniform",
                "motions": [{"name": "uniform-salute"}]
            }]
        });
        let room = json!({
            "viewMode": "vn",
            "costumeSelections": {"actor-1": "uniform"}
        });

        assert_eq!(
            motion_names(&character, &room, true),
            vec!["uniform-salute"]
        );
        assert!(motion_names(&character, &room, false).is_empty());
    }

    #[test]
    fn visual_novel_falls_back_to_character_motions_without_costume() {
        let character = json!({
            "id": "actor-1",
            "motions": [{"name": "wave"}, {"name": "jump"}],
            "costumes": [{
                "name": "uniform",
                "motions": [{"name": "uniform-salute"}]
            }]
        });

        for room in [
            json!({"viewMode": "vn"}),
            json!({"viewMode": "vn", "costumeSelections": {"actor-1": "default"}}),
            json!({"viewMode": "vn", "costumeSelections": {"actor-1": "missing"}}),
        ] {
            assert_eq!(motion_names(&character, &room, true), vec!["wave", "jump"]);
        }
    }

    #[test]
    fn history_message_content_formats_file_and_image_attachments() {
        let file_only = json!({
            "role": "user",
            "content": "これ読んで",
            "attachments": [{
                "id": "att-1",
                "kind": "file",
                "name": "memo.txt",
                "mimeType": "text/plain",
                "data": "一行目\n二行目"
            }]
        });
        assert_eq!(
            history_message_content(&file_only),
            json!("これ読んで\n\n[添付ファイル: memo.txt]\n一行目\n二行目")
        );

        let image_and_text = json!({
            "role": "user",
            "content": "これ何？",
            "attachments": [{
                "id": "att-2",
                "kind": "image",
                "name": "photo.png",
                "mimeType": "image/png",
                "data": "data:image/png;base64,AAAA"
            }]
        });
        assert_eq!(
            history_message_content(&image_and_text),
            json!([
                {"type": "text", "text": "これ何？"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
            ])
        );

        let image_only = json!({
            "role": "user",
            "content": "",
            "attachments": [{
                "id": "att-3",
                "kind": "image",
                "name": "photo.png",
                "mimeType": "image/png",
                "data": "data:image/png;base64,BBBB"
            }]
        });
        assert_eq!(
            history_message_content(&image_only),
            json!([
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}}
            ])
        );
    }

    #[test]
    fn history_message_content_keeps_name_only_markers_for_dataless_attachments() {
        let message = json!({
            "role": "user",
            "content": "これ何？",
            "attachments": [
                {
                    "id": "att-img",
                    "kind": "image",
                    "name": "old.png",
                    "mimeType": "image/png",
                    "data": ""
                },
                {
                    "id": "att-file",
                    "kind": "file",
                    "name": "old.txt",
                    "mimeType": "text/plain",
                    "data": ""
                }
            ]
        });
        assert_eq!(
            history_message_content(&message),
            json!("これ何？\n\n[添付画像: old.png]\n\n[添付ファイル: old.txt]")
        );
    }

    #[test]
    fn memory_extraction_request_replaces_image_attachments_with_text_placeholders() {
        let mut context = extraction_context();
        context.recent_history = vec![json!({
            "role": "user",
            "content": "",
            "attachments": [
                {
                    "id": "att-img",
                    "kind": "image",
                    "name": "cat.png",
                    "mimeType": "image/png",
                    "data": "data:image/png;base64,SECRET_BASE64"
                },
                {
                    "id": "att-file",
                    "kind": "file",
                    "name": "profile.txt",
                    "mimeType": "text/plain",
                    "data": "猫が大好き"
                }
            ]
        })];
        let (_system, input) = memory_extraction_request(&context, None, &[]);
        let first_message = &input["recentMessages"][0];
        assert!(first_message.get("attachments").is_none());
        assert_eq!(
            first_message["content"],
            "[添付画像: cat.png]\n\n[添付ファイル: profile.txt]\n猫が大好き"
        );
    }

    #[test]
    fn debug_logs_omit_base64_image_payloads() {
        let prompt = serde_json::to_string_pretty(&json!([
            {"role": "user", "content": [
                {"type": "text", "text": "これ何？"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJDREVGRw=="}},
            ]},
        ]))
        .expect("serializable");
        let mut logs = Vec::new();

        push_debug_log(
            &mut logs,
            json!({
                "prompt": prompt,
                "json": "{\"message\": \"ok\"}",
                "reasoning": "data:image/png;base64,UkVBU09O",
                "secondJson": "data:;base64,U0VDT05E",
            }),
        );

        let prompt = logs[0]["prompt"].as_str().expect("prompt string");
        assert!(prompt.contains("data:image/png;base64,[base64省略:12chars]"));
        assert!(!prompt.contains("QUJDREVGRw=="));
        assert_eq!(logs[0]["json"], "{\"message\": \"ok\"}");
        assert_eq!(
            logs[0]["reasoning"],
            "data:image/png;base64,[base64省略:8chars]"
        );
        assert_eq!(logs[0]["secondJson"], "data:;base64,[base64省略:8chars]");
    }

    #[test]
    fn base64_redaction_keeps_non_data_url_text() {
        assert_eq!(
            redact_base64_data_urls("base64の話;base64,ではない"),
            "base64の話;base64,ではない"
        );
        assert_eq!(
            redact_base64_data_urls("data:text/plain,hello"),
            "data:text/plain,hello"
        );
        assert_eq!(
            redact_base64_data_urls("data:image/png;base64,"),
            "data:image/png;base64,"
        );
        // `data:` 以降に引用符がある場合は別用途の文字列として残す。
        assert_eq!(
            redact_base64_data_urls("key: \"data:\" value"),
            "key: \"data:\" value"
        );
    }

    #[test]
    fn base64_redaction_handles_multiple_urls_and_text() {
        let text = "前 data:image/png;base64,QUJD 中 \"data:image/jpeg;base64,QUJDREU=\" 後";
        assert_eq!(
            redact_base64_data_urls(text),
            "前 data:image/png;base64,[base64省略:4chars] 中 \"data:image/jpeg;base64,[base64省略:8chars]\" 後"
        );
    }
}
