use std::{
    collections::{HashMap, HashSet},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{Json, extract::State};
use serde_json::{Map, Value, json};

use crate::{
    AppState,
    ai::{
        AiProviderConfig, Provider,
        routes::{
            extract_message_text, memory_extraction_prompt, memory_schema, parse_memory_updates,
            structured_completion,
        },
    },
    error::{AppError, AppResult},
};

use super::{
    prompts::{
        DIRECTOR_TRANSCRIPT_USER_HISTORY, SUMMARY_RECENT_USER_TURNS_TO_KEEP, actor_id,
        assistant_schema, boolean, character_setting, character_system_prompt, director_prompts,
        director_schema, string, summary_prompts, summary_schema,
    },
    response::{
        AssistantEnvelope, DirectorDecision, parse_assistant_response, parse_director_decision,
        parse_summary_response,
    },
};

const DEFAULT_MAX_HISTORY: usize = 20;
const DEFAULT_MAX_TOKENS: u64 = 2048;
const DEFAULT_TEMPERATURE: f64 = 0.8;
const DEFAULT_TOP_P: f64 = 1.0;
const DEFAULT_TOP_K: u64 = 0;
const MEMORY_LIMIT: usize = 8;
const MEMORY_MIN_IMPORTANCE: f64 = 0.4;
const MEMORY_MIN_CONFIDENCE: f64 = 0.7;
const MEMORY_MAX_CANDIDATES: usize = 5;

fn situation_max_turns(room: &Value, situation: &Value, participant_count: usize) -> usize {
    if participant_count <= 1 {
        return 1;
    }

    room.get("maxMentionChain")
        .and_then(Value::as_u64)
        .or_else(|| {
            situation
                .pointer("/director/maxAutoTurns")
                .and_then(Value::as_u64)
        })
        .unwrap_or(3)
        .clamp(1, 10) as usize
}

pub async fn turn(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> AppResult<Json<Value>> {
    Ok(Json(run_turn(state, payload).await?))
}

pub(crate) async fn run_turn(state: AppState, payload: Value) -> AppResult<Value> {
    let room = object_field(&payload, "room")?.clone();
    let mut history = array_field_or(&payload, "messages", &room, "messages");
    history.retain(|message| !boolean(message, "archived"));
    if history.is_empty() {
        return Err(AppError::BadRequest(
            "messages に会話履歴が必要です。".into(),
        ));
    }

    let secret_mode = payload
        .get("secretMode")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| boolean(&room, "secretMode"));
    let situation = payload.get("situation").filter(|value| value.is_object());
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

    let provider_config = payload
        .get("aiProviderConfig")
        .filter(|value| !value.is_null())
        .cloned()
        .map(serde_json::from_value::<AiProviderConfig>)
        .transpose()
        .map_err(|error| AppError::BadRequest(format!("aiProviderConfig が不正です: {error}")))?;
    let provider = Provider::resolve(
        state.http_client.clone(),
        state.application_origin.clone(),
        provider_config,
    )?;

    let summary_character = if situation.is_some() {
        participants.first()
    } else {
        character
    };
    let summary_model = payload
        .get("summaryModel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("google/gemini-2.5-flash-lite");
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
    let previous_summary = string(&room, "summary");
    let fallback_summary = (!previous_summary.is_empty()).then_some(previous_summary.clone());
    let summary_attempt = maybe_summarize(
        &provider,
        &history,
        previous_summary,
        summary_character.is_some_and(|value| boolean(value, "enableSummary")),
        history_limit,
        situation.is_some(),
        summary_model,
        situation,
        &participants,
    )
    .await;
    let (current_summary, active_history) = match summary_attempt {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!(%error, "conversation summary failed; continuing with full history");
            (fallback_summary.clone(), history.clone())
        }
    };
    let summary_result = if active_history.len() < history.len() {
        current_summary.as_ref().map(|summary| {
            json!({
                "text": summary,
                "checkpointUserMessageId": history
                    .iter()
                    .rev()
                    .find(|message| string(message, "role") == "user")
                    .map(|message| string(message, "id")),
                "keepCount": active_history.len(),
            })
        })
    } else {
        None
    };

    let room_id = string(&room, "id");
    let use_message_mode = string(&room, "viewMode") == "message";
    let latest_user_message = active_history
        .iter()
        .rev()
        .find(|message| string(message, "role") == "user")
        .map(|message| string(message, "content"))
        .unwrap_or_default();

    let mut generated = Vec::new();
    let mut usages = Vec::new();
    let mut think_logs = Vec::new();
    let mut full_json_logs = Vec::new();
    let mut used_memory_ids = Vec::new();
    let mut extraction_context: Option<ExtractionContext> = None;

    if let Some(situation) = situation {
        let max_turns = situation_max_turns(&room, situation, participants.len());
        let stop_after_one = situation
            .pointer("/director/stopPolicy")
            .and_then(Value::as_str)
            == Some("after-one");
        let director_model = situation
            .pointer("/director/model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                participants
                    .first()
                    .and_then(|value| value.get("model"))
                    .and_then(Value::as_str)
            })
            .ok_or_else(|| AppError::BadRequest("指揮役モデルが設定されていません。".into()))?;

        for turn_index in 0..max_turns {
            let mut combined = active_history.clone();
            combined.extend(generated.clone());
            let banned_actor_id = if turn_index > 0 && participants.len() > 1 {
                combined
                    .iter()
                    .rev()
                    .find(|message| string(message, "role") == "assistant")
                    .and_then(|message| message.get("characterId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            } else {
                None
            };

            let decision = if participants.len() == 1 {
                DirectorDecision {
                    actor_id: Some(actor_id(&participants[0])),
                    reason: "Only participant".into(),
                    candidates: vec![(actor_id(&participants[0]), "Only participant".into())],
                }
            } else {
                request_director(
                    &provider,
                    situation,
                    &participants,
                    &combined,
                    &latest_user_message,
                    turn_index,
                    max_turns,
                    banned_actor_id.as_deref(),
                    director_model,
                    secret_mode,
                    &room,
                    &mut usages,
                    &mut full_json_logs,
                )
                .await?
            };

            let selected_id = decision.actor_id.as_deref();
            let Some(actor) = selected_id.and_then(|selected| {
                participants
                    .iter()
                    .find(|actor| actor_id(actor) == selected)
            }) else {
                break;
            };
            let actor_history =
                group_history_for_actor(&combined, actor, &participants, history_limit);
            let memory_allowed = !secret_mode
                && string(situation, "memoryMode") == "readOnly"
                && string(actor, "actorType") == "character"
                && !string(actor, "sourceCharacterId").is_empty();
            let memory_character_id = {
                let source = string(actor, "sourceCharacterId");
                if source.is_empty() {
                    string(actor, "id")
                } else {
                    source
                }
            };
            let relevant = if memory_allowed {
                search_memories(
                    &state,
                    &provider,
                    &payload,
                    &memory_character_id,
                    &room_id,
                    &actor_history,
                )
                .await
                .unwrap_or_default()
            } else {
                Vec::new()
            };
            extend_unique(
                &mut used_memory_ids,
                relevant.iter().map(|memory| memory.id.clone()),
            );
            let generated_messages = generate_for_character(
                &provider,
                actor,
                &actor_history,
                &room,
                Some(situation),
                &participants,
                current_summary.as_deref(),
                &relevant,
                use_message_mode,
                secret_mode,
                &mut usages,
                &mut think_logs,
                &mut full_json_logs,
                generated.len(),
            )
            .await?;
            generated.extend(generated_messages);
            if stop_after_one {
                break;
            }
        }
    } else if let Some(character) = character {
        let memory_allowed =
            !secret_mode && !matches!(character.get("enableMemory"), Some(Value::Bool(false)));
        let relevant = if memory_allowed {
            search_memories(
                &state,
                &provider,
                &payload,
                &string(character, "id"),
                &room_id,
                &active_history,
            )
            .await
            .unwrap_or_default()
        } else {
            Vec::new()
        };
        extend_unique(
            &mut used_memory_ids,
            relevant.iter().map(|memory| memory.id.clone()),
        );
        generated = generate_for_character(
            &provider,
            character,
            &slice_by_user_history(&active_history, history_limit),
            &room,
            None,
            &[],
            current_summary.as_deref(),
            &relevant,
            use_message_mode,
            secret_mode,
            &mut usages,
            &mut think_logs,
            &mut full_json_logs,
            0,
        )
        .await?;
        if memory_allowed {
            extraction_context = Some(ExtractionContext {
                character: character.clone(),
                recent_history: active_history.clone(),
                existing_memories: relevant,
            });
        }
    }

    let memory_candidates = if !secret_mode {
        if let Some(context) = extraction_context {
            extract_memory_candidates(
                &provider,
                &payload,
                context,
                &generated,
                &room_id,
                &mut usages,
            )
            .await
            .unwrap_or_default()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    if secret_mode {
        usages.clear();
        think_logs.clear();
        full_json_logs.clear();
        used_memory_ids.clear();
    }
    Ok(json!({
        "messages": generated,
        "usages": usages,
        "thinkLogs": think_logs,
        "fullJsonLogs": full_json_logs,
        "summary": summary_result,
        "memoryCandidates": memory_candidates,
        "usedMemoryIds": used_memory_ids,
    }))
}

#[allow(clippy::too_many_arguments)]
async fn generate_for_character(
    provider: &Provider,
    character: &Value,
    history: &[Value],
    room: &Value,
    situation: Option<&Value>,
    participants: &[Value],
    summary: Option<&str>,
    memories: &[ScoredMemory],
    message_mode: bool,
    secret_mode: bool,
    usages: &mut Vec<Value>,
    think_logs: &mut Vec<Value>,
    full_json_logs: &mut Vec<Value>,
    id_offset: usize,
) -> AppResult<Vec<Value>> {
    let expression_names = expression_names(character, room, situation.is_none());
    let schema = assistant_schema(
        &expression_names,
        message_mode,
        boolean(character, "thinkModeEnabled"),
    );
    let system_prompt = character_system_prompt(
        character,
        message_mode,
        &expression_names,
        summary,
        &memories
            .iter()
            .map(|memory| memory.content.clone())
            .collect::<Vec<_>>(),
        situation,
        participants,
    );
    let mut request_messages = vec![json!({
        "role": "system",
        "content": system_prompt,
    })];
    request_messages.extend(history.iter().map(|message| {
        json!({
            "role": string(message, "role"),
            "content": string(message, "content"),
        })
    }));
    let body = json!({
        "model": string(character, "model"),
        "messages": request_messages,
        "max_tokens": number_u64(character, "maxTokens", DEFAULT_MAX_TOKENS),
        "temperature": number_f64(character, "temperature", DEFAULT_TEMPERATURE),
        "top_p": number_f64(character, "topP", DEFAULT_TOP_P),
        "top_k": number_u64(character, "topK", DEFAULT_TOP_K),
        "stream": false,
    });
    let prompt = serde_json::to_string_pretty(&body["messages"])
        .expect("completion messages must be serializable");
    let started = now_ms();
    let raw = structured_completion(provider, body, schema, 120).await?;
    let content = extract_message_text(&raw);
    let envelope = parse_assistant_response(&content, &expression_names, message_mode)?;
    if !secret_mode {
        push_usage(usages, &raw, character, "chat");
        full_json_logs.push(json!({
            "roomId": string(room, "id"),
            "roomName": string(room, "name"),
            "characterId": actor_id(character),
            "characterName": string(character, "name"),
            "model": string(character, "model"),
            "status": "success",
            "source": "assistant-json",
            "prompt": prompt,
            "json": content,
            "elapsedMs": now_ms().saturating_sub(started),
        }));
        if let Some(thinking) = &envelope.thinking {
            think_logs.push(json!({
                "roomId": string(room, "id"),
                "roomName": string(room, "name"),
                "characterId": actor_id(character),
                "characterName": string(character, "name"),
                "thinking": thinking,
            }));
        }
    }
    Ok(envelope_to_messages(
        envelope,
        character,
        message_mode,
        id_offset,
    ))
}

fn envelope_to_messages(
    envelope: AssistantEnvelope,
    character: &Value,
    message_mode: bool,
    id_offset: usize,
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
            message.insert("timestamp".into(), json!(timestamp + index as u64));
            if index == 0
                && let Some(expression) = &envelope.expression
            {
                message.insert("expression".into(), Value::String(expression.clone()));
            }
            Value::Object(message)
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn request_director(
    provider: &Provider,
    situation: &Value,
    actors: &[Value],
    messages: &[Value],
    latest_user_message: &str,
    turn_index: usize,
    max_turns: usize,
    banned_actor_id: Option<&str>,
    model: &str,
    secret_mode: bool,
    room: &Value,
    usages: &mut Vec<Value>,
    full_json_logs: &mut Vec<Value>,
) -> AppResult<DirectorDecision> {
    let actor_ids = actors.iter().map(actor_id).collect::<Vec<_>>();
    let eligible_ids = actor_ids
        .iter()
        .filter(|id| Some(id.as_str()) != banned_actor_id)
        .cloned()
        .collect::<Vec<_>>();
    if eligible_ids.is_empty() {
        return Ok(DirectorDecision {
            actor_id: None,
            reason: "No eligible actor".into(),
            candidates: Vec::new(),
        });
    }
    let transcript_messages = slice_by_user_history(messages, DIRECTOR_TRANSCRIPT_USER_HISTORY);
    let transcript = director_transcript(&transcript_messages, actors);
    let (system, user) = director_prompts(
        situation,
        actors,
        &transcript,
        latest_user_message,
        turn_index,
        max_turns,
        banned_actor_id,
    );
    let schema = director_schema(&eligible_ids);
    let mut request = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": 768,
        "temperature": 0.2,
        "stream": false,
    });
    if provider.is_openrouter() {
        request["reasoning"] = json!({"effort": "none"});
    }
    let prompt = serde_json::to_string_pretty(&request["messages"])
        .expect("director messages must be serializable");
    let raw = structured_completion(provider, request, schema, 120).await?;
    let content = extract_message_text(&raw);
    let mut decision = parse_director_decision(&content, &eligible_ids)?;
    if let Some(banned) = banned_actor_id {
        decision.candidates.retain(|(id, _)| id != banned);
        if decision.actor_id.as_deref() == Some(banned) {
            decision.actor_id = decision.candidates.first().map(|value| value.0.clone());
            decision.reason = decision
                .candidates
                .first()
                .map(|value| value.1.clone())
                .unwrap_or_else(|| "直前の発言者の連続発言を防止".into());
        }
    }
    if !secret_mode {
        push_usage_with_id(
            usages,
            &raw,
            &format!("{}:director", string(situation, "id")),
            model,
            "director",
        );
        full_json_logs.push(json!({
            "roomId": string(room, "id"),
            "roomName": string(room, "name"),
            "characterId": format!("{}:director", string(situation, "id")),
            "characterName": "指揮役",
            "model": model,
            "status": "success",
            "source": "director-json",
            "prompt": prompt,
            "json": content,
        }));
    }
    Ok(decision)
}

#[allow(clippy::too_many_arguments)]
async fn maybe_summarize(
    provider: &Provider,
    history: &[Value],
    previous_summary: String,
    enabled: bool,
    history_limit: usize,
    group: bool,
    model: &str,
    situation: Option<&Value>,
    participants: &[Value],
) -> AppResult<(Option<String>, Vec<Value>)> {
    let existing = (!previous_summary.is_empty()).then_some(previous_summary);
    if !enabled || count_user_messages(history) <= history_limit {
        return Ok((existing, history.to_vec()));
    }
    let cut = cut_before_last_user_messages(history, SUMMARY_RECENT_USER_TURNS_TO_KEEP);
    let to_summarize = &history[..cut];
    if to_summarize.len() < 2 {
        return Ok((existing, history.to_vec()));
    }
    let named_messages = if group {
        with_speaker_names(to_summarize, participants, situation)
    } else {
        to_summarize.to_vec()
    };
    let (system, user) = summary_prompts(&named_messages, existing.as_deref(), group);
    let raw = structured_completion(
        provider,
        json!({
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": 2048,
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
    provider: &Provider,
    payload: &Value,
    character_id: &str,
    room_id: &str,
    messages: &[Value],
) -> AppResult<Vec<ScoredMemory>> {
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
        .map(|message| string(message, "content"))
        .unwrap_or_else(|| {
            messages
                .iter()
                .map(|message| string(message, "content"))
                .collect::<Vec<_>>()
                .join("\n")
        });
    let recent_ids = messages
        .iter()
        .filter_map(|message| message.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let embedding_model = payload
        .get("memoryEmbeddingModel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("openai/text-embedding-3-small");
    let query_embedding =
        request_embedding(provider, payload, &query, embedding_model, "search_query")
            .await
            .ok()
            .flatten();
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
        .map(|memory| {
            let content = string(&memory, "content");
            let lexical = lexical_similarity(&query, &content);
            let vector = query_embedding
                .as_ref()
                .filter(|_| string(&memory, "embeddingModel") == embedding_model)
                .and_then(|query| {
                    memory
                        .get("embedding")
                        .and_then(Value::as_array)
                        .map(|values| values.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
                        .map(|stored| cosine_similarity(query, &stored).max(0.0))
                })
                .unwrap_or(0.0);
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
            let score = if query_embedding.is_some() && vector > 0.0 {
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
            ScoredMemory {
                id: string(&memory, "id"),
                content,
                data: memory,
                score,
            }
        })
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.score.total_cmp(&a.score));
    scored.truncate(MEMORY_LIMIT);
    Ok(scored)
}

async fn request_embedding(
    provider: &Provider,
    payload: &Value,
    input: &str,
    model: &str,
    input_type: &str,
) -> AppResult<Option<Vec<f64>>> {
    if input.trim().is_empty() {
        return Ok(None);
    }
    if payload
        .pointer("/aiProviderConfig/aiProvider")
        .and_then(Value::as_str)
        == Some("openai-compatible")
        && payload
            .pointer("/aiProviderConfig/openAiCompatibleEmbeddingsEnabled")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Ok(None);
    }
    let mut body = json!({
        "input": input,
        "model": model,
        "encoding_format": "float",
    });
    if provider.is_openrouter() {
        body["input_type"] = Value::String(input_type.into());
        body["provider"] = json!({"data_collection": "deny"});
    }
    let response = provider
        .post("embeddings", Duration::from_secs(12))
        .json(&body)
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let data: Value = response.json().await?;
    Ok(data
        .pointer("/data/0/embedding")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
        .filter(|values| !values.is_empty()))
}

struct ExtractionContext {
    character: Value,
    recent_history: Vec<Value>,
    existing_memories: Vec<ScoredMemory>,
}

async fn extract_memory_candidates(
    provider: &Provider,
    payload: &Value,
    context: ExtractionContext,
    generated: &[Value],
    room_id: &str,
    usages: &mut Vec<Value>,
) -> AppResult<Vec<Value>> {
    let model = payload
        .get("memoryExtractionModel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("google/gemini-2.5-flash-lite");
    let mut recent = context
        .recent_history
        .iter()
        .rev()
        .take(6)
        .cloned()
        .collect::<Vec<_>>();
    recent.reverse();
    recent.extend(generated.iter().cloned());
    let body = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": memory_extraction_prompt(),
            },
            {
                "role": "user",
                "content": serde_json::to_string(&json!({
                    "targetCharacter": string(&context.character, "name"),
                    "characterSystemPrompt": character_setting(&context.character),
                    "recentMessages": recent,
                    "existingMemories": context.existing_memories.iter().map(|memory| &memory.data).collect::<Vec<_>>(),
                }))?,
            },
        ],
        "temperature": 0.1,
        "stream": false,
    });
    let raw = structured_completion(provider, body, memory_schema(), 60).await?;
    push_usage(usages, &raw, &context.character, "memory-extraction");
    let content = extract_message_text(&raw);
    let setting = character_setting(&context.character);
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

fn group_history_for_actor(
    messages: &[Value],
    actor: &Value,
    participants: &[Value],
    history_limit: usize,
) -> Vec<Value> {
    let actor_key = actor_id(actor);
    let names = participants
        .iter()
        .map(|participant| (actor_id(participant), string(participant, "name")))
        .collect::<HashMap<_, _>>();
    let converted = messages
        .iter()
        .map(|message| {
            let role = string(message, "role");
            let mut content = string(message, "content");
            let message_actor = string(message, "characterId");
            let output_role = if role == "assistant" && message_actor == actor_key {
                "assistant"
            } else {
                if role == "assistant" {
                    let name = names
                        .get(&message_actor)
                        .map(String::as_str)
                        .unwrap_or("???");
                    content = format!("{name}: {content}");
                }
                "user"
            };
            json!({
                "id": message.get("id").cloned().unwrap_or(Value::Null),
                "role": output_role,
                "content": content,
            })
        })
        .collect::<Vec<_>>();
    slice_by_user_history(&converted, history_limit)
}

fn director_transcript(messages: &[Value], actors: &[Value]) -> String {
    let names = actors
        .iter()
        .map(|actor| (actor_id(actor), string(actor, "name")))
        .collect::<HashMap<_, _>>();
    messages
        .iter()
        .map(|message| {
            if string(message, "role") == "user" {
                format!("主人公: {}", string(message, "content"))
            } else {
                let id = string(message, "characterId");
                format!(
                    "{}: {}",
                    names.get(&id).map(String::as_str).unwrap_or("???"),
                    string(message, "content")
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
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
                value["name"] = Value::String(names.get(&id).cloned().unwrap_or_default());
            }
            value
        })
        .collect()
}

fn expression_names(character: &Value, room: &Value, allow_vn: bool) -> Vec<String> {
    if !allow_vn || string(room, "viewMode") != "vn" {
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

fn names_from_expressions(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|expression| string(expression, "name"))
        .filter(|name| !name.is_empty())
        .collect()
}

fn push_usage(usages: &mut Vec<Value>, raw: &Value, character: &Value, source: &str) {
    let id = {
        let source_id = string(character, "sourceCharacterId");
        if source_id.is_empty() {
            string(character, "id")
        } else {
            source_id
        }
    };
    push_usage_with_id(usages, raw, &id, &string(character, "model"), source);
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
    fn similar_memory_text_scores_high() {
        assert!(memory_similarity("主人公はコーヒーが好き", "主人公はコーヒーが好き。") > 0.9);
    }

    #[test]
    fn single_participant_situation_is_limited_to_one_turn() {
        let room = json!({"maxMentionChain": 8});
        let situation = json!({"director": {"maxAutoTurns": 6}});

        assert_eq!(situation_max_turns(&room, &situation, 1), 1);
    }

    #[test]
    fn multi_participant_situation_uses_configured_turn_limit() {
        let situation = json!({"director": {"maxAutoTurns": 6}});

        assert_eq!(situation_max_turns(&json!({}), &situation, 2), 6);
        assert_eq!(
            situation_max_turns(&json!({"maxMentionChain": 4}), &situation, 2),
            4
        );
    }
}
